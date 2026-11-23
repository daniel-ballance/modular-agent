use modular_agent::{Capacity, Code, ResourceLimits, Timing, testing::test_agent};

#[tokio::test]
async fn last_agent_input_slot_has_one_winner_and_can_be_handed_back() -> modular_agent::Result<()>
{
    let agent = test_agent()
        .several_actors(true)
        .resource_limits(ResourceLimits {
            agent: Capacity {
                inputs: 1,
                ..Capacity::default()
            },
            ..ResourceLimits::default()
        })
        .build()
        .await?;
    let a = agent.session().await?;
    let b = agent.session().await?;
    let opts = |key: &str| Some(key.to_owned());
    let (first, second) = tokio::join!(
        a.send_with("first", Timing::Propose, opts("first")),
        b.send_with("second", Timing::Propose, opts("second")),
    );
    let (accepted, receipt, refused, text) = match (first, second) {
        (Ok(receipt), Err(error)) => {
            assert_eq!(error.code(), Code::Busy);
            (&a, receipt, &b, "second")
        }
        (Err(error), Ok(receipt)) => {
            assert_eq!(error.code(), Code::Busy);
            (&b, receipt, &a, "first")
        }
        _ => panic!("exactly one admission must succeed"),
    };
    let winner = if text == "first" { "second" } else { "first" };
    assert!(
        accepted
            .send_with(winner, Timing::Propose, opts(winner))
            .await?
            .duplicate
    );
    accepted.withdraw(&receipt.input_id).await?;
    assert!(
        !refused
            .send_with(text, Timing::Propose, opts(text))
            .await?
            .duplicate
    );
    agent.close().await
}

#[tokio::test]
async fn uncovered_call_list_records_usage_and_a_capacity_limit() -> modular_agent::Result<()> {
    for served in [false, true] {
        check_uncovered_call_list(served).await?;
    }
    Ok(())
}

async fn check_uncovered_call_list(served: bool) -> modular_agent::Result<()> {
    use modular_agent::{Outcome, Tool};
    use serde_json::json;
    let mut builder = test_agent()
        .tool(Tool::new("never", "must not run").run::<serde_json::Value, String, _, _>(|_, _| async {
            panic!("a call from an uncovered response was dispatched");
        }))
        .resource_limits(ResourceLimits {
            session: Capacity { calls: 1, ..Capacity::default() },
            ..ResourceLimits::default()
        })
        .script(json!([{"toolCalls":[{"name":"never","input":{}},{"name":"never","input":{}}],"usage":{"input":4,"output":2}}]));
    if served {
        builder = builder.over_wire(
            modular_agent::Plugin::new("reservation-runtime")
                .replaces("runtime")
                .setup(|r| r.runtime(SingleStep)),
        );
    }
    let agent = builder.build().await?;
    assert_eq!(
        agent.declaration()?["resourceReservations"]["session"]["calls"],
        1
    );
    let session = agent.session().await?;
    let result = session.prompt("two calls").await?;
    assert_eq!(
        result.outcome,
        Some(Outcome::Limit {
            limit: "capacity".into()
        })
    );
    let history = session.history().await?;
    let response = history
        .iter()
        .find(|entry| entry["kind"] == "response")
        .unwrap();
    assert_eq!(response["message"]["stop"], "failed");
    assert_eq!(response["message"]["content"], json!([]));
    assert_eq!(response["message"]["usage"]["input"], 4);
    agent.close().await
}

struct SingleStep;

#[modular_agent::async_trait]
impl modular_agent::RuntimePart for SingleStep {
    async fn resume_turn(
        &self,
        _: modular_agent::RuntimeTurn,
        _: modular_agent::InterruptedTurn,
        _: modular_agent::RuntimeContext,
    ) -> modular_agent::Result<modular_agent::RuntimeOutcome> {
        unreachable!()
    }
    async fn continue_open_calls(
        &self,
        _: modular_agent::RuntimeTurn,
        _: Vec<modular_agent::RuntimeCall>,
        _: modular_agent::RuntimeContext,
    ) -> modular_agent::Result<modular_agent::RuntimeOutcome> {
        unreachable!()
    }
    fn declaration(&self) -> modular_agent::RuntimeDeclaration {
        modular_agent::RuntimeDeclaration {
            id: "single-step".into(),
            supports: Default::default(),
        }
    }

    async fn run_turn(
        &self,
        _: modular_agent::RuntimeTurn,
        cx: modular_agent::RuntimeContext,
    ) -> modular_agent::Result<modular_agent::RuntimeOutcome> {
        use modular_agent::{Outcome, Usage};
        use serde_json::json;
        let id = cx.new_id().await?;
        let request = cx.prepare_step(&id, Usage::default()).await?;
        let response = cx.model(&id, request).await?;
        assert_eq!(response.0["stop"], "failed");
        assert_eq!(response.0["content"], json!([]));
        let entry = cx
            .record(json!({"kind":"response","stepId":id,"visible":true,"message":response}))
            .await?;
        cx.hook("step.after", json!({"stepId":id,"response":response}))
            .await?;
        Ok(modular_agent::RuntimeOutcome {
            outcome: Outcome::Completed,
            result: json!({"text":"","openToolCalls":[]}),
            entries: vec![entry["id"].as_str().unwrap().into()],
            usage: response
                .get("usage")
                .cloned()
                .map(serde_json::from_value)
                .transpose()?
                .unwrap_or_default(),
        })
    }
}

#[tokio::test]
async fn restart_rebuilds_tenant_input_slots_before_open() -> modular_agent::Result<()> {
    use modular_agent::{Durability, file_history, testing::restart};
    let home = tempfile::tempdir()?;
    let agent = test_agent()
        .project(home.path())
        .durability(Durability::Kept)
        .history(file_history(home.path().join("history"))?)
        .several_actors(true)
        .resource_limits(ResourceLimits {
            tenant: Capacity {
                inputs: 1,
                ..Capacity::default()
            },
            ..ResourceLimits::default()
        })
        .build()
        .await?;
    let old = agent.session().await?;
    old.send("parked before restart", Timing::Propose).await?;
    // The tenantless bucket also includes a session that has not been reopened.
    let agent = restart(agent).await?;
    let fresh = agent.session().await?;
    assert_eq!(
        fresh
            .send("no room", Timing::Propose)
            .await
            .unwrap_err()
            .code(),
        Code::Busy
    );
    agent.close().await
}
