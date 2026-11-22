use modular_agent::{
    Code, Result, ServeHistoryOptions, file_history, listen_history, portable_file_history,
};
use serde_json::Value;
use std::{path::Path, time::Duration};

const TOKEN: &str = "history-lease-ttl-test-token-not-for-deployment";

fn options(dir: &Path) -> Result<ServeHistoryOptions> {
    let token_file = dir.join("token");
    std::fs::write(&token_file, TOKEN)?;
    Ok(ServeHistoryOptions::new(
        "127.0.0.1:0".parse().unwrap(),
        token_file,
    ))
}

async fn declared_ttl_ms(url: &str) -> Value {
    let declaration: Value = reqwest::Client::new()
        .get(format!("{url}/v1"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    declaration["ttlMs"].clone()
}

#[tokio::test]
async fn declares_a_fifteen_second_lease_by_default() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = file_history(root.path().join("history"))?;
    let server = listen_history(store, options(root.path())?).await?;
    assert_eq!(declared_ttl_ms(&server.url).await, 15_000);
    server.close().await;
    Ok(())
}

#[tokio::test]
async fn declares_the_configured_lease() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut opts = options(root.path())?;
    opts.lease_ttl = Duration::from_millis(1234);
    let native = file_history(root.path().join("native"))?;
    let portable = portable_file_history(
        root.path().join("portable"),
        opts.lease_ttl,
        opts.max_sessions,
    )?;
    for store in [native, portable] {
        let server = listen_history(store, opts.clone()).await?;
        assert_eq!(declared_ttl_ms(&server.url).await, 1234);
        server.close().await;
    }
    Ok(())
}

#[tokio::test]
async fn refuses_invalid_lease_durations() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut opts = options(root.path())?;
    let native = file_history(root.path().join("native"))?;
    let portable = portable_file_history(
        root.path().join("portable"),
        opts.lease_ttl,
        opts.max_sessions,
    )?;
    for duration in [
        Duration::ZERO,
        Duration::from_micros(999),
        Duration::from_micros(1500),
    ] {
        opts.lease_ttl = duration;
        for store in [&native, &portable] {
            let error = listen_history(store.clone(), opts.clone())
                .await
                .err()
                .expect("invalid lease duration accepted");
            assert_eq!(error.code(), Code::InvalidParams, "{duration:?}: {error}");
        }
    }
    Ok(())
}

#[tokio::test]
async fn refuses_a_lease_that_does_not_match_the_portable_store() -> Result<()> {
    let root = tempfile::tempdir()?;
    let opts = options(root.path())?;
    let store = portable_file_history(
        root.path().join("portable"),
        Duration::from_millis(1234),
        opts.max_sessions,
    )?;
    let error = listen_history(store, opts)
        .await
        .err()
        .expect("mismatched lease duration accepted");
    assert_eq!(error.code(), Code::InvalidParams);
    Ok(())
}
