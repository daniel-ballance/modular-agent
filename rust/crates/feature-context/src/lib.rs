use agent_api::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
pub struct ContextPlugin;

fn cut_before(entries: &[&Entry], keep: u64, force: bool) -> Result<usize> {
    let results: BTreeMap<_, _> = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.kind == "tool.result")
        .filter_map(|(i, e)| Some((e.scope.call.as_deref()?, i)))
        .collect();
    let mut safe = Vec::with_capacity(entries.len() + 1);
    let mut steps = Vec::new();
    let mut through = 0;
    let mut has_calls = false;
    for (i, entry) in entries.iter().enumerate() {
        safe.push(i >= through);
        if entry.kind != "model.response" {
            continue;
        }
        let response: ModelResponse =
            serde_json::from_value(entry.content.as_ref().unwrap().clone())?;
        if matches!(
            response.stop.as_str(),
            "failed" | "aborted" | "refused" | "limit" | "length"
        ) {
            continue;
        }
        steps.push(i);
        for call in response.tool_calls() {
            has_calls = true;
            // A late result pins the whole span. A missing result pins the
            // rest of the view, including for an Interface handoff.
            through = through.max(results.get(call.id.as_str()).map_or(usize::MAX, |i| i + 1));
        }
    }
    safe.push(entries.len() >= through);

    let first_new = entries
        .iter()
        .position(|e| e.kind != "summary")
        .unwrap_or(entries.len());
    let latest_input = entries.iter().rposition(|e| e.kind == "input");
    let input_cut = latest_input.filter(|&i| i > first_new && safe[i]);
    // Preserve the standalone command's full-history behavior outside a
    // single tool turn, subject to the same pairing rule.
    if force
        && (!has_calls || input_cut.is_some())
        && let Some(cut) = (first_new + 1..=entries.len()).rev().find(|&i| safe[i])
    {
        return Ok(cut);
    }
    if let Some(cut) = input_cut {
        return Ok(cut);
    }

    let mut tokens = 0;
    let mut end = entries.len();
    let mut cut = 0;
    let first = steps.partition_point(|&i| latest_input.is_some_and(|input| i <= input));
    for &step in steps.get(first + 1..).unwrap_or_default().iter().rev() {
        for entry in &entries[step..end] {
            tokens += serde_json::to_vec(&entry.content)?.len().div_ceil(4) as u64;
        }
        end = step;
        if safe[step] && (cut == 0 || tokens <= keep) {
            cut = step;
        }
    }
    Ok(cut)
}

async fn compact(api: Api, scope: &Scope, system: &str, force: bool, budget: u64) -> Result<bool> {
    let data = api.snapshot(&scope.session)?;
    let branch = data.branch();
    let visible = context_entries(&branch);
    let keep = data.settings["keep_recent_tokens"]
        .as_u64()
        .unwrap_or(20_000)
        .min(budget);
    let boundary = cut_before(&visible, keep, force)?;
    let old = &visible[..boundary];
    if old.is_empty() {
        return Ok(false);
    }
    let covered: BTreeSet<_> = old.iter().map(|e| e.id.as_str()).collect();
    let sources: Vec<_> = branch
        .iter()
        .filter(|e| covered.contains(e.id.as_str()))
        .map(|e| e.id.clone())
        .collect();
    let selection: Arc<dyn ModelSelection> = capability(api.as_ref(), "model.selection")?;
    let model = selection.select(api.clone(), scope).await?;
    let mut request = ModelRequest {
        session: scope.session.clone(),
        system: format!(
            "{system}\nSummarize the supplied history faithfully and concisely. Preserve the user's goal, decisions, important facts, tool outcomes and next steps. Do not call tools."
        ),
        messages: messages_with_origins(old, &branch)?,
        thinking: data.settings["thinking"].as_str().unwrap_or("").into(),
        output_limit: 1024,
        ..ModelRequest::default()
    };
    // Auxiliary inference also goes through the output gate.
    request = serde_json::from_value(
        api.output(
            scope,
            Output {
                recipient: "model".into(),
                value: json!(request),
                stream: None,
                end: true,
            },
        )
        .await?
        .ok_or_else(|| anyhow!("summary request blocked"))?,
    )?;
    let attempt_scope = Scope {
        step: Some(id()),
        ..scope.clone()
    };
    let response = model
        .generate_attempt(
            api.clone(),
            attempt_scope.clone(),
            request,
            if force {
                CancellationToken::new()
            } else {
                api.cancellation(&scope.session)?
            },
            ModelAttempt {
                writer: "context.management",
                tools: vec![],
                sources: sources.clone(),
                auxiliary: true,
                safe_to_repeat: false,
                replay: None,
                close_attempt: None,
                authorized_wire: None,
            },
        )
        .await?;
    let intent = api
        .snapshot(&scope.session)?
        .branch()
        .into_iter()
        .find(|e| e.kind == "model.request" && e.scope.step == attempt_scope.step)
        .ok_or_else(|| anyhow!("missing auxiliary attempt"))?;
    api.append(
        &attempt_scope,
        "context.management",
        Draft::new("model.response", false, json!(response)).copying(vec![intent.id]),
    )?;
    ensure!(
        matches!(response.stop.as_str(), "finished" | "length")
            && response.tool_calls().is_empty()
            && !response.text_content().trim().is_empty(),
        "invalid summary response"
    );
    api.append(
        scope,
        "context.management",
        Draft::new(
            "summary",
            true,
            json!({"text":response.text_content(),"on_demand":force,"usage":response.usage}),
        )
        .copying(sources),
    )?;
    model.discard(&scope.session).await?;
    Ok(true)
}
impl Plugin for ContextPlugin {
    fn name(&self) -> &str {
        "context.management"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "runtime.before.step",
            Order::Normal,
            handler(|api, scope, mut value| {
                Box::pin(async move {
                    let data = api.snapshot(&scope.session)?;
                    let mut request: ModelRequest =
                        serde_json::from_value(value["request"].clone())?;
                    let branch = data.branch();
                    let visible = context_entries(&branch);
                    let bytes = serde_json::to_vec(&messages_with_origins(&visible, &branch)?)?
                        .len()
                        + request.system.len()
                        + serde_json::to_vec(&request.tools)?.len();
                    let window = value["limits"]["context_window"].as_u64().unwrap_or(128000);
                    let threshold = data.settings["context_tokens"]
                        .as_u64()
                        .unwrap_or(window.saturating_sub(request.output_limit));
                    let threshold = threshold.min(window.saturating_sub(request.output_limit));
                    if value["attempt"].as_u64().unwrap_or(0) == 0 && bytes as u64 / 4 > threshold {
                        compact(api.clone(), &scope, &request.system, false, threshold).await?;
                    }
                    let branch = api.snapshot(&scope.session)?.branch();
                    request.messages = messages_with_origins(&context_entries(&branch), &branch)?;
                    for feedback in pending_result_feedback(&branch, scope.turn.as_deref()) {
                        if let Some(reason) =
                            feedback.content.as_ref().and_then(|v| v["reason"].as_str())
                        {
                            request.messages.push(Message::text("user", reason));
                        }
                    }
                    value["request"] = json!(request);
                    Ok(answer(value))
                })
            }),
        );
        r.on(
            "runtime.model.failed",
            Order::Normal,
            handler(|api, scope, value| {
                Box::pin(async move {
                    if value["failure"]["kind"] == "context_too_large" && value["attempt"] == 0 {
                        if !compact(api.clone(), &scope, "", false, u64::MAX).await? {
                            return Ok(answer(json!({"retry":false})));
                        }
                        let branch = api.snapshot(&scope.session)?.branch();
                        let mut request: ModelRequest =
                            serde_json::from_value(value["request"].clone())?;
                        request.messages =
                            messages_with_origins(&context_entries(&branch), &branch)?;
                        return Ok(answer(json!({"retry":true, "request":request})));
                    }
                    Ok(HookResult::default())
                })
            }),
        );
        r.command(
            "compact",
            handler(|api, scope, _| {
                Box::pin(async move {
                    ensure!(
                        !api.is_running(&scope.session),
                        "cannot manually compact during a turn"
                    );
                    Ok(answer(
                        json!({"compacted":compact(api,&scope,"",true,u64::MAX).await?}),
                    ))
                })
            }),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod boundaries;
