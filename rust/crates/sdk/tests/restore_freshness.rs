use modular_agent::{
    Actor, Code, Durability, FileHistoryOptions, Rights, ServeHistoryOptions, file_history,
    file_history_with_options, http_history, listen_history, testing::test_agent,
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

#[tokio::test(flavor = "multi_thread")]
async fn file_and_http_restore_freshness() -> modular_agent::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../conformance/history/restore-freshness.json"
    ))
    .unwrap();
    for http in [false, true] {
        for case in &cases {
            let root = tempfile::tempdir()?;
            let dir = root.path().join("history");
            let token = root.path().join("token");
            fs::write(&token, "fixture-0123456789-0123456789-0123456789")?;
            let mut options = ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), &token);
            options.lease_ttl = Duration::from_millis(500);
            let store = || {
                file_history_with_options(
                    &dir,
                    FileHistoryOptions {
                        restore_witness: Some(root.path().join("witness")),
                    },
                )
            };
            let history = store()?;
            let service = if http {
                Some(listen_history(history.clone(), options.clone()).await?)
            } else {
                None
            };
            let build = |history| {
                test_agent()
                    .project(root.path())
                    .several_actors(true)
                    .durability(Durability::Kept)
                    .history(history)
                    .script(json!([{"text":"private response"}]))
                    .build()
            };
            let agent = build(match &service {
                Some(service) => http_history(&service.url, &token)?,
                None => history,
            })
            .await?;
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
            agent.close().await?;
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
            let history = store()?;
            let service = if http {
                Some(listen_history(history.clone(), options.clone()).await?)
            } else {
                None
            };
            let restored = build(match &service {
                Some(service) => http_history(&service.url, &token)?,
                None => history,
            })
            .await?;
            if http {
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
