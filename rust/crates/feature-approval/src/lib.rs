//! Approval policy is a replaceable feature, not a Runtime decision.
use agent_api::*;
pub struct ApprovalPlugin;
impl Plugin for ApprovalPlugin {
    fn name(&self) -> &str {
        "feature.approval"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "runtime.before.tool",
            Order::Last,
            handler(|api, scope, value| {
                Box::pin(async move {
                    let settings = api.snapshot(&scope.session)?.settings;
                    let policy = settings["approval"].as_str().unwrap_or("ask_always");
                    let refuse = |text: &str| HookResult {
                        refused: Some(text.into()),
                        ..HookResult::default()
                    };
                    match policy {
                        "off" => return Ok(answer(value)),
                        "ask_unless_read_only" if value["definition"]["read_only"] == true => {
                            return Ok(answer(value));
                        }
                        "never_ask" => return Ok(refuse("approval policy refuses without asking")),
                        "ask_always" | "ask_unless_read_only" => (),
                        _ => return Ok(refuse("unknown approval policy")),
                    }
                    let call: ToolCall = serde_json::from_value(value["call"].clone())?;
                    let mut q = Question::new(
                        scope.clone(),
                        RequestKind::Approval,
                        &format!("Allow {} with {}?", call.name, call.input),
                    );
                    q.options = vec!["allow".into(), "refuse".into()];
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
                    q.key = Some(format!("approval:{}:{}", call.id, call.input));
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
                    if questions(&api.snapshot(&scope.session)?)?
                        .iter()
                        .any(|old| old.scope.call == scope.call && old.waits_for_approval())
                    {
                        return Ok(answer(value));
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
                            Ok(answer(value))
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
        r.declare(
            json!({"approval_policies":["ask_unless_read_only","ask_always","never_ask","off"]}),
        );
        Ok(())
    }
}
