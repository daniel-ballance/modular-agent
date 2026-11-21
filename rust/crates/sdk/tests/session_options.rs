use modular_agent::{Actor, Code, Result, Rights, SessionOptions, Timing, testing::test_agent};
use serde_json::json;

#[tokio::test]
async fn session_options_default_off() -> Result<()> {
    let agent = test_agent().build().await?;
    let decl = agent.declaration()?;
    assert_eq!(decl["severalActors"], false);
    assert_eq!(decl["sessionLimits"], false);
    assert_eq!(decl["tenants"], false);
    let session = agent.session().await?;
    assert!(session.r#as("user").is_ok());
    assert!(matches!(session.r#as("viewer"), Err(e) if e.code() == Code::NotSupported));
    assert_eq!(
        session.set_limit(None).unwrap_err().code(),
        Code::NotSupported
    );
    assert_eq!(
        session
            .send("hello", Timing::Propose)
            .await
            .unwrap_err()
            .code(),
        Code::NotSupported
    );
    let tenanted = agent
        .session_with(SessionOptions {
            tenant: Some("trial".into()),
            ..Default::default()
        })
        .await;
    assert!(matches!(tenanted, Err(e) if e.code() == Code::NotSupported));
    agent.close().await
}

#[tokio::test]
async fn actor_views_use_current_shared_rights() -> Result<()> {
    let agent = test_agent()
        .several_actors(true)
        .session_limits(true)
        .tenants(json!({"trial":{"rights":["input","watch","grant","administer"]}}))
        .script(json!([{"text":"Hello."}]))
        .build()
        .await?;
    let decl = agent.declaration()?;
    assert_eq!(decl["severalActors"], true);
    assert_eq!(decl["sessionLimits"], true);
    assert_eq!(decl["tenants"], true);
    let session = agent
        .session_with(SessionOptions {
            tenant: Some("trial".into()),
            actors: vec![Actor {
                id: "guest".into(),
                kind: "user".into(),
                rights: Rights::only(&["input", "watch"]),
            }],
            ..Default::default()
        })
        .await?;
    let guest = session.r#as("guest")?;
    assert_eq!(guest.cancel().await.unwrap_err().code(), Code::Forbidden);
    let fork = guest.fork()?;
    assert_eq!(fork.cancel().await.unwrap_err().code(), Code::Forbidden);
    assert_eq!(fork.prompt("hello").await?.text, "Hello.");
    assert_eq!(guest.prompt("hello").await?.text, "Hello.");
    let entry = guest
        .history()
        .await?
        .into_iter()
        .find(|row| row["kind"] == "input")
        .unwrap();
    assert_eq!(entry["actorId"], "guest");

    session.set_limit(Some(Rights::only(&["watch", "grant", "administer"])))?;
    assert_eq!(
        guest.prompt("again").await.unwrap_err().code(),
        Code::Forbidden
    );
    session.leave("guest").await?;
    assert_eq!(guest.history().await.unwrap_err().code(), Code::Forbidden);
    agent.close().await
}
