use modular_agent::{Capacity, Code, ResourceLimits, Timing, testing::test_agent};

#[tokio::test]
async fn last_agent_input_slot_has_one_winner_and_can_be_handed_back() -> modular_agent::Result<()>
{
    let agent = test_agent()
        .several_actors(true)
        .resource_limits(ResourceLimits {
            agent: Capacity { inputs: 1 },
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
