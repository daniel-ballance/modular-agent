//! Approval policy is a replaceable feature, not a Runtime decision.
use agent_api::*;
#[derive(Default)]
pub struct ApprovalPlugin {
    pub covers_nested: bool,
}
impl Plugin for ApprovalPlugin {
    fn name(&self) -> &str {
        "feature.approval"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let covers_nested = self.covers_nested;
        r.on(
            "runtime.before.tool",
            Order::Last,
            handler(move |api, scope, value| {
                Box::pin(async move {
                    let data = api.snapshot(&scope.session)?;
                    let settings = &data.settings;
                    let policy = match settings.get("approval") {
                        Some(value) => value.as_str().unwrap_or("never_ask"),
                        None if covers_nested => "ask_always",
                        None => "off",
                    };
                    let refuse = |text: &str| HookResult {
                        refused: Some(text.into()),
                        ..HookResult::default()
                    };
                    match policy {
                        "never_ask" => return Ok(refuse("approval policy refuses without asking")),
                        "off" | "ask_always" | "ask_unless_read_only" => (),
                        _ => return Ok(refuse("unknown approval policy")),
                    }
                    let call: ToolCall = serde_json::from_value(value["call"].clone())?;
                    if covers_nested && let Some(cover) = api.covering_approval(&scope, &call) {
                        return Ok(HookResult {
                            approval_cover: Some(cover),
                            ..answer(value)
                        });
                    }
                    let previous = questions(&data)?;
                    let waiting = previous
                        .iter()
                        .find(|old| old.scope.call == scope.call && old.waits_for_approval());
                    if waiting.is_none()
                        && (policy == "off"
                            || policy == "ask_unless_read_only"
                                && value["definition"]["read_only"] == true)
                    {
                        return Ok(answer(value));
                    }
                    let mut q = Question::new(
                        scope.clone(),
                        RequestKind::Approval,
                        &format!("Allow {} with {}?", call.name, call.input),
                    );
                    let offer_cover = covers_nested && call.started_by != "tool";
                    if offer_cover {
                        q.extra["coversNested"] = json!(true);
                        q.text.push_str(
                            " An allow covers the nested calls it makes in this dispatch.",
                        );
                    }
                    q.extra["approvalCall"] = wire::call(&call, &scope);
                    if let Some((source, definition)) =
                        api.capability_names("tools.").into_iter().find_map(|key| {
                            let data = api.snapshot(&scope.session).ok()?;
                            let cap = capability::<dyn ToolSource>(api.as_ref(), &key).ok()?;
                            cap.tools(&data)
                                .into_iter()
                                .find(|tool| tool.name == call.name)
                                .map(|def| {
                                    (
                                        api.tool_registration(&key),
                                        wire::registered_definition(&def),
                                    )
                                })
                        })
                    {
                        q.extra["source"] = source;
                        q.extra["definition"] = definition;
                    }
                    q.key = if offer_cover {
                        // Recovery may show an unanswered question again. Never reuse a spent allow.
                        previous
                            .iter()
                            .rev()
                            .find(|old| {
                                old.scope == scope
                                    && old.covers_nested()
                                    && old.answerable
                                    && old.answer.is_none()
                                    && ["approvalCall", "source", "definition"]
                                        .iter()
                                        .all(|key| wire::json_eq(&old.extra[key], &q.extra[key]))
                            })
                            .and_then(|old| old.key.clone())
                            .or_else(|| Some(format!("approval:{}:{}", call.id, q.id)))
                    } else {
                        Some(format!("approval:{}:{}", call.id, call.input))
                    };
                    q.timeout_ms = settings["approval_timeout_ms"].as_u64();
                    q.extra["whenTimeLimit"] = json!("decline");
                    if let Some(parked) = api.park_approval(&q)? {
                        return Ok(if parked {
                            HookResult {
                                suspended: true,
                                ..answer(value)
                            }
                        } else {
                            refuse("approval has no eligible answerer")
                        });
                    }
                    // Never ask a replacement question on a continuation's bound call.
                    let approved = |request_id: String, offered: bool, value| HookResult {
                        approval_cover: (offer_cover && offered).then(|| ApprovalCover {
                            tool_call_id: call.id.clone(),
                            request_id,
                        }),
                        ..answer(value)
                    };
                    if let Some(old) = waiting {
                        return Ok(
                            if ["approvalCall", "source", "definition"]
                                .iter()
                                .all(|key| wire::json_eq(&old.extra[key], &q.extra[key]))
                            {
                                // The Harness checks the bound decision again at first handoff.
                                approved(old.id.clone(), old.covers_nested(), value)
                            } else {
                                refuse("the call changed at its approval gate")
                            },
                        );
                    }
                    match requests(api.as_ref())?
                        .ask(api.clone(), q, api.cancellation(&scope.session)?)
                        .await?
                    {
                        RequestReply::Answer(a)
                            if !a.declined
                                && a.value == "allow"
                                && api.authority(&a.session, &a.actor)?.has("approve") =>
                        {
                            Ok(approved(a.request, true, value))
                        }
                        RequestReply::Waiting => Ok(HookResult {
                            suspended: true,
                            ..answer(value)
                        }),
                        _ => Ok(refuse("approval refused or no authorized answerer")),
                    }
                })
            }),
        );
        let mut declaration =
            json!({"approval_policies":["ask_unless_read_only","ask_always","never_ask","off"]});
        if covers_nested {
            declaration["approval_covers_nested"] = json!(true);
        }
        r.declare(declaration);
        Ok(())
    }
}
