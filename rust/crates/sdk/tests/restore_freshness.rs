use modular_agent::{
    Actor, Code, Durability, FileHistoryOptions, History, HistoryServer, Rights,
    ServeHistoryOptions, file_history, file_history_with_options, http_history, listen_history,
    portable_file_history_with_options, testing::test_agent,
};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir(dst)?;
    for item in src.read_dir()? {
        let item = item?;
        let target = dst.join(item.file_name());
        if item.file_type()?.is_dir() {
            copy_dir(&item.path(), &target)?;
        } else {
            fs::copy(item.path(), target)?;
        }
    }
    Ok(())
}

fn open_store(
    dir: &Path,
    portable: bool,
    service: &ServeHistoryOptions,
    witness: Option<&Path>,
) -> modular_agent::Result<History> {
    let options = FileHistoryOptions {
        restore_witness: witness.map(Path::to_owned),
    };
    if portable {
        portable_file_history_with_options(dir, service.lease_ttl, service.max_sessions, options)
    } else {
        file_history_with_options(dir, options)
    }
}

const TOKEN: &str = "fixture-0123456789-0123456789-0123456789";

fn serve_options(root: &Path) -> modular_agent::Result<ServeHistoryOptions> {
    let token = root.join("token");
    fs::write(&token, TOKEN)?;
    let mut options = ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), token);
    options.lease_ttl = Duration::from_secs(2);
    Ok(options)
}

async fn connect(
    store: History,
    http: bool,
    options: &ServeHistoryOptions,
    token: &Path,
) -> modular_agent::Result<(History, Option<HistoryServer>)> {
    if http {
        let server = listen_history(store, options.clone()).await?;
        Ok((http_history(&server.url, token)?, Some(server)))
    } else {
        Ok((store, None))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_file_and_http_restore_freshness() -> modular_agent::Result<()> {
    assert_restore_freshness(false).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn portable_file_and_http_restore_freshness() -> modular_agent::Result<()> {
    assert_restore_freshness(true).await
}

async fn assert_restore_freshness(portable: bool) -> modular_agent::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../conformance/history/restore-freshness.json"
    ))
    .unwrap();
    for http in [false, true] {
        for case in &cases {
            let root = tempfile::tempdir()?;
            let dir = root.path().join("history");
            let token = root.path().join("token");
            let options = serve_options(root.path())?;
            let witness = root.path().join("witness");
            let store = || open_store(&dir, portable, &options, Some(&witness));
            let (history, service) = connect(store()?, http, &options, &token).await?;
            let build = |history| {
                test_agent()
                    .project(root.path())
                    .several_actors(true)
                    .durability(Durability::Kept)
                    .history(history)
                    .script(json!([{"text":"private response"}]))
                    .build()
            };
            let agent = build(history).await?;
            let writer = agent.session().await?;
            let id = writer.id().to_owned();
            writer
                .join(Actor {
                    id: "guest".into(),
                    kind: "user".into(),
                    rights: Rights::only(&["watch"]),
                })
                .await?;
            writer.prompt("private input").await?;
            let view = writer.history().await?;
            let target = view.iter().find(|e| e["kind"] == "input").unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            writer.close().await?;
            drop(writer);
            let old = root.path().join("old");
            copy_dir(&dir, &old)?;
            let writer = agent.open_session(&id).await?;
            if case["change"] == "erasure" {
                assert!(
                    writer
                        .erase(vec![target.clone()])
                        .await?
                        .erased
                        .iter()
                        .any(|e| e.id == target)
                );
            } else {
                writer.leave("guest").await?;
            }
            writer.close().await?;
            drop(writer);
            agent.close().await?;
            // Drop the direct portable store's exclusive control lease before restoring.
            drop(agent);
            if let Some(service) = service {
                service.close().await;
            }
            let latest = root.path().join("latest");
            fs::rename(&dir, &latest)?;
            fs::rename(old, &dir)?;
            assert!(
                matches!(store(), Err(e) if e.code() == Code::Unavailable),
                "HTTP={http}, case={case}"
            );
            fs::remove_dir_all(&dir)?;
            fs::rename(latest, &dir)?;
            let (history, service) = connect(store()?, http, &options, &token).await?;
            let restored = build(history).await?;
            if http || portable {
                tokio::time::sleep(options.lease_ttl).await;
            }
            let writer = restored.open_session(&id).await?;
            let records = writer.history().await?;
            assert!(
                records.iter().any(|e| e["kind"] == case["recordKind"]),
                "HTTP={http}, case={case}"
            );
            restored.close().await?;
            if let Some(service) = service {
                service.close().await;
            }
        }
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nonempty_served_history_does_not_recreate_registry() -> anyhow::Result<()> {
    for portable in [false, true] {
        let root = tempfile::tempdir()?;
        let dir = root.path().join("history");
        let options = serve_options(root.path())?;
        // Registry refusal must work even without a witness.
        let store = || open_store(&dir, portable, &options, None);
        let server = listen_history(store()?, options.clone()).await?;
        let client = reqwest::Client::new();
        let url = format!("{}/v1/sessions/known", server.url);
        let created = client
            .put(&url)
            .bearer_auth(TOKEN)
            .json(&json!({"project":"/","created":0}))
            .send()
            .await?;
        assert!(created.status().is_success());
        let plans = || {
            client
                .get(format!("{url}/pending-erasure"))
                .bearer_auth(TOKEN)
        };
        assert!(plans().send().await?.status().is_success());

        let registry = dir.join(".erasure");
        fs::remove_dir_all(&registry)?;
        let reply = plans().send().await?;
        assert_eq!(reply.status(), 503);
        assert_eq!(reply.json::<Value>().await?["code"], "unavailable");
        assert!(!registry.exists());
        server.close().await;
        // The same refusal happens at construction, before a restart can bind.
        assert!(matches!(store(), Err(e) if e.code() == Code::Unavailable));
        assert!(!registry.exists());
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_history_requires_the_configured_external_witness() -> anyhow::Result<()> {
    for portable in [false, true] {
        let root = tempfile::tempdir()?;
        let dir = root.path().join("history");
        let options = serve_options(root.path())?;
        let inside = dir.join("witness");
        let witness = root.path().join("witness");
        let open = |path: Option<&Path>| open_store(&dir, portable, &options, path);
        assert!(matches!(open(Some(&inside)), Err(e) if e.code() == Code::Unavailable));
        assert!(!inside.exists());
        let store = open(Some(&witness))?;
        let client = reqwest::Client::new();
        let server = listen_history(store, options.clone()).await?;
        let read = || {
            client
                .get(format!("{}/v1/sessions", server.url))
                .bearer_auth(TOKEN)
        };
        assert!(read().send().await?.status().is_success());

        let saved = root.path().join("witness-saved");
        fs::rename(&witness, &saved)?;
        let reply = read().send().await?;
        assert_eq!(reply.status(), 503);
        assert_eq!(reply.json::<Value>().await?["code"], "unavailable");
        server.close().await;
        assert!(matches!(open(Some(&witness)), Err(e) if e.code() == Code::Unavailable));
        assert!(!witness.exists());
        assert!(matches!(open(None), Err(e) if e.code() == Code::Unavailable));

        fs::rename(saved, &witness)?;
        drop(open(Some(&witness))?);
    }
    Ok(())
}

#[tokio::test]
async fn nonempty_history_does_not_recreate_registry() -> modular_agent::Result<()> {
    let root = tempfile::tempdir()?;
    let dir = root.path().join("history");
    let agent = test_agent()
        .project(root.path())
        .durability(Durability::Kept)
        .history(file_history(&dir)?)
        .script(json!([{"text":"stored"}]))
        .build()
        .await?;
    agent.session().await?.prompt("persist").await?;
    agent.close().await?;
    let registry = dir.join(".erasure");
    fs::remove_dir_all(&registry)?;
    assert!(matches!(file_history(&dir), Err(e) if e.code() == Code::Unavailable));
    assert!(!registry.exists());
    Ok(())
}
