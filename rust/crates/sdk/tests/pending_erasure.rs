use modular_agent::{Durability, file_history, testing::test_agent};
use serde_json::json;

#[tokio::test]
async fn erasing_a_source_does_not_require_a_held_copy_lease() -> modular_agent::Result<()> {
    let root = tempfile::tempdir()?;
    let history = file_history(root.path().join("history"))?;
    let build = || {
        test_agent()
            .project(root.path())
            .durability(Durability::Kept)
            .history(history.clone())
            .script(json!([{"text":"private marker"}]))
            .build()
    };
    let a = build().await?;
    let source = a.session().await?;
    source.prompt("erase me").await?;
    let entry = source
        .history()
        .await?
        .into_iter()
        .find(|e| e["kind"] == "response")
        .unwrap();
    let target = entry["id"].as_str().unwrap().to_owned();
    let fork = source.fork()?;
    let copy_id = fork.id().to_owned();
    fork.close().await?;
    let b = build().await?;
    let copy = b.open_session(&copy_id).await?;
    let report = source.erase(vec![target.clone()]).await?;
    assert!(report.erased.iter().any(|entry| entry.id == target));
    assert!(
        report
            .out_of_reach
            .iter()
            .any(|v| v == "copies in other sessions")
    );
    a.close().await?;
    let view = copy.history().await?;
    assert!(!json!(view).to_string().contains("private marker"));
    b.close().await?;
    let c = build().await?;
    let copy = c.open_session(&copy_id).await?;
    assert_eq!(
        copy.history()
            .await?
            .iter()
            .filter(|e| e["kind"] == "erasure")
            .count(),
        1
    );
    c.close().await
}
