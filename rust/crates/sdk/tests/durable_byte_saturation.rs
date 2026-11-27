use agent_api::{HistoryStore, SessionData};
use modular_agent::{
    ByteCapacity, ByteLimits, Code, Durability, History, ServeHistoryOptions, file_history,
    http_history, listen_history, testing::test_agent,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    input: String,
    response: String,
    ordinary_write_bytes: usize,
    control_headroom_bytes: u64,
}

#[tokio::test(flavor = "multi_thread")]
async fn native_history_keeps_the_byte_boundary() -> modular_agent::Result<()> {
    saturation(false).await
}

#[tokio::test(flavor = "multi_thread")]
async fn http_history_keeps_the_byte_boundary() -> modular_agent::Result<()> {
    saturation(true).await
}

async fn saturation(http: bool) -> modular_agent::Result<()> {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../conformance/history/durable-byte-saturation.json"
    ))?;
    let root = tempfile::tempdir()?;
    let dir = root.path().join("history");
    let token = "fixture-0123456789-0123456789-0123456789";
    let token_file = root.path().join("token");
    std::fs::write(&token_file, token)?;
    let service = if http {
        Some(
            listen_history(
                file_history(&dir)?,
                ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), &token_file),
            )
            .await?,
        )
    } else {
        None
    };
    let history = || -> modular_agent::Result<History> {
        if let Some(service) = &service {
            http_history(&service.url, &token_file)
        } else {
            file_history(&dir)
        }
    };
    let inspector: Box<dyn HistoryStore> = if let Some(service) = &service {
        Box::new(history_http::HttpHistory::new(&service.url, token)?)
    } else {
        Box::new(history_fs::FileHistory::new(&dir)?)
    };
    let build = || {
        test_agent()
            .project(root.path())
            .durability(Durability::Kept)
            .script(json!([{"text": fixture.response}]))
    };
    let agent = build().history(history()?).build().await?;
    let source = agent.session().await?;
    source.prompt(fixture.input.as_str()).await?;
    let id = source.id().to_owned();
    source.close().await?;
    agent.close().await?;

    let snapshot = || -> modular_agent::Result<(SessionData, Vec<u8>)> {
        let data = inspector.inspect(&id)?;
        let encoded = serde_json::to_vec(&data)?;
        Ok((data, encoded))
    };
    let (before, original) = snapshot()?;
    let target = before
        .entries
        .iter()
        .find(|e| e.kind == "input")
        .unwrap()
        .id
        .clone();
    let retained = original.len() as u64;
    let limits = |storage, control| {
        let cap = ByteCapacity {
            storage,
            control,
            buffered: 1_000_000,
        };
        ByteLimits {
            session: cap,
            tenant: cap,
            agent: cap,
        }
    };
    let agent = build()
        .history(history()?)
        .byte_limits(limits(retained, 0))
        .build()
        .await?;
    let source = agent.open_session(&id).await?;
    assert_eq!(
        source
            .set_setting("title", json!("x".repeat(fixture.ordinary_write_bytes)))
            .unwrap_err()
            .code(),
        Code::Busy
    );
    assert_eq!(snapshot()?.1, original);
    assert!(matches!(source.fork(), Err(e) if e.code() == Code::Busy));
    assert_eq!(inspector.list(None)?.len(), 1);
    assert_eq!(snapshot()?.1, original);

    let report = source.erase(vec![target.clone()]).await?;
    assert!(report.erased.is_empty());
    assert!(report.pending.iter().any(|copy| copy.id == target));
    assert_eq!(
        snapshot()?.1,
        original,
        "no bookkeeping or tombstone on refusal"
    );
    assert!(
        source.history().await.is_err(),
        "pending content stays fenced"
    );
    // Closing can also report the fenced view; dropping the handles releases the lease.
    let _ = agent.close().await;
    drop(source);
    drop(agent);

    let headroom = fixture.control_headroom_bytes;
    let agent = build()
        .history(history()?)
        .byte_limits(limits(retained + headroom, headroom))
        .build()
        .await?;
    let source = agent.open_session(&id).await?;
    let records = snapshot()?.0.entries;
    assert_eq!(records.iter().filter(|e| e.kind == "erasure").count(), 1);
    assert!(
        records
            .iter()
            .any(|e| e.id == target && e.content.is_none())
    );
    assert!(source.erase(vec![target.clone()]).await?.pending.is_empty());
    assert_eq!(
        snapshot()?
            .0
            .entries
            .iter()
            .filter(|e| e.kind == "erasure")
            .count(),
        1
    );
    agent.close().await?;
    if let Some(service) = service {
        service.close().await;
    }
    Ok(())
}
