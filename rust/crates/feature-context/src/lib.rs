use agent_api::*;
use std::{collections::BTreeSet, sync::Arc};
pub struct ContextPlugin;
fn view(branch: &[Entry]) -> Vec<Entry> {
    let mut covered = BTreeSet::new();
    for e in branch
        .iter()
        .filter(|e| e.kind == "summary" && e.content.is_some())
    {
        covered.extend(e.copies.iter().cloned());
    }
    let active: Vec<_> = branch
        .iter()
        .filter(|e| e.visible && !covered.contains(&e.id))
        .cloned()
        .collect();
    active
        .iter()
        .filter(|e| e.kind == "summary")
        .chain(active.iter().filter(|e| e.kind != "summary"))
        .cloned()
        .collect()
}
async fn compact(api: Api, scope: &Scope, system: &str, force: bool) -> Result<bool> {
    let data = api.snapshot(&scope.session)?;
    let visible = view(&data.branch());
    // Keep the newest actor input and all model/tool records after it as one unit.
    let mut boundary = if force {
        visible.len()
    } else {
        visible
            .iter()
            .rposition(|e| e.kind == "input")
            .unwrap_or(visible.len())
    };
    if boundary == 0 {
        boundary = visible.len();
    }
    let old = &visible[..boundary];
    if old.is_empty() {
        return Ok(false);
    }
    let selection: Arc<dyn ModelSelection> = capability(api.as_ref(), "model.selection")?;
    let model = selection.select(api.clone(), scope).await?;
    let mut request = ModelRequest {
        session: scope.session.clone(),
        system: format!(
            "{system}\nSummarize the supplied history faithfully and concisely. Preserve important facts and outstanding tool outcomes. Do not call tools."
        ),
        messages: messages_with_origins(old, &data.branch())?,
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
                sources: old.iter().map(|e| e.id.clone()).collect(),
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
        response.tool_calls().is_empty() && !response.text_content().trim().is_empty(),
        "invalid summary response"
    );
    let copies = old.iter().map(|e| e.id.clone()).collect();
    api.append(
        scope,
        "context.management",
        Draft::new(
            "summary",
            true,
            json!({"text":response.text_content(),"on_demand":force,"usage":response.usage}),
        )
        .copying(copies),
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
                    let visible = view(&branch);
                    let bytes = serde_json::to_vec(&messages_with_origins(&visible, &branch)?)?
                        .len()
                        + request.system.len()
                        + serde_json::to_vec(&request.tools)?.len();
                    let window = value["limits"]["context_window"].as_u64().unwrap_or(128000);
                    let threshold = data.settings["context_tokens"]
                        .as_u64()
                        .unwrap_or(window.saturating_sub(request.output_limit));
                    if bytes as u64 / 4 > threshold.min(window.saturating_sub(request.output_limit))
                    {
                        compact(api.clone(), &scope, &request.system, false).await?;
                    }
                    let branch = api.snapshot(&scope.session)?.branch();
                    request.messages = messages_with_origins(&view(&branch), &branch)?;
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
                        let compacted = compact(api, &scope, "", false).await?;
                        return Ok(answer(json!({"retry":compacted})));
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
                        json!({"compacted":compact(api,&scope,"",true).await?}),
                    ))
                })
            }),
        )?;
        Ok(())
    }
}
