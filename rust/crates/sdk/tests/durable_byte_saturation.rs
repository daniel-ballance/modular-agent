use agent_api::{HistoryStore, SessionData};
use modular_agent::{
    ByteCapacity, ByteLimits, Code, Durability, History, ServeHistoryOptions, file_history,
    http_history, listen_history, testing::test_agent,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Notify;

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

#[derive(Default)]
struct RewindEnvironment {
    entered: Notify,
    resume: Notify,
    pause_target: AtomicBool,
    fail_target: AtomicBool,
    fail_undo: AtomicBool,
}

#[agent_api::async_trait]
impl agent_api::WorkingEnvironment for ArcFixture {
    fn declaration(&self) -> serde_json::Value {
        json!({"rewinding":true})
    }
    async fn save_point(&self, _: &str, project: &Path) -> agent_api::Result<String> {
        Ok(std::fs::read_to_string(project.join("file.txt"))?)
    }
    async fn check_point(&self, _: &str, _: &Path, point: &str) -> agent_api::Result<bool> {
        Ok(point == "target" || point == "current")
    }
    async fn restore_point(&self, _: &str, project: &Path, point: &str) -> agent_api::Result<()> {
        if point == "target" {
            if self.0.pause_target.load(Ordering::Relaxed) {
                self.0.entered.notify_one();
                self.0.resume.notified().await;
            }
            if self.0.fail_target.load(Ordering::Relaxed) {
                std::fs::write(project.join("file.txt"), "partial")?;
                agent_api::bail!("target restore failed");
            }
        } else if self.0.fail_undo.load(Ordering::Relaxed) {
            agent_api::bail!("undo restore unavailable");
        }
        std::fs::write(project.join("file.txt"), point)?;
        Ok(())
    }
    async fn read(&self, project: &Path, path: &str) -> agent_api::Result<String> {
        Ok(std::fs::read_to_string(project.join(path))?)
    }
    async fn write(&self, _: &Path, _: &str, _: &str) -> agent_api::Result<()> {
        unreachable!()
    }
    async fn edit(&self, _: &Path, _: &str, _: &str, _: &str) -> agent_api::Result<()> {
        unreachable!()
    }
    async fn bash(
        &self,
        _: agent_api::Api,
        _: agent_api::Scope,
        _: PathBuf,
        _: &str,
        _: agent_api::CancellationToken,
    ) -> agent_api::Result<agent_api::ToolResult> {
        unreachable!()
    }
}

#[derive(Clone)]
struct ArcFixture(Arc<RewindEnvironment>);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Restore {
    Complete,
    Compensate,
    Recover,
}

#[tokio::test(flavor = "multi_thread")]
async fn rewind_settles_with_control_headroom() -> modular_agent::Result<()> {
    for mode in [Restore::Complete, Restore::Compensate, Restore::Recover] {
        rewind_saturation(mode).await?;
    }
    Ok(())
}

async fn rewind_saturation(mode: Restore) -> modular_agent::Result<()> {
    use modular_agent::{
        Agent, MoveOptions, Plugin,
        testing::{SCRIPTED_MODEL, scripted_provider},
    };
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../conformance/history/durable-byte-saturation.json"
    ))?;
    let root = tempfile::tempdir()?;
    let dir = root.path().join("history");
    let project = root.path().join("source");
    let other = root.path().join("filler");
    for path in [&project, &other] {
        std::fs::create_dir(path)?;
        std::fs::write(path.join("file.txt"), "target")?;
    }
    let file = project.join("file.txt");
    let env = Arc::new(RewindEnvironment::default());
    let build = |path: &Path| -> modular_agent::Result<_> {
        let fixture_env = ArcFixture(env.clone());
        Ok(Agent::builder()
            .project(path)
            .durability(Durability::Kept)
            .history(file_history(&dir)?)
            .provider(scripted_provider(
                json!([{"text":fixture.response},{"text":fixture.response}]),
            ))
            .model(SCRIPTED_MODEL)
            .plugin(
                Plugin::new("rewind-fixture")
                    .replaces("working-environment")
                    .setup(move |r| r.environment(fixture_env.clone())),
            ))
    };
    let seed = build(&project)?.build().await?;
    let source = seed.session().await?;
    source.prompt("before the rewind target").await?;
    source.prompt(fixture.input.as_str()).await?;
    let source_id = source.id().to_owned();
    seed.close().await?;
    let seed = build(&other)?.build().await?;
    let filler = seed.session().await?;
    filler.prompt("seed filler").await?;
    filler.set_setting("title", json!(""))?;
    let filler_id = filler.id().to_owned();
    seed.close().await?;
    std::fs::write(&file, "current")?;

    let store = history_fs::FileHistory::new(&dir)?;
    let snapshot = || store.inspect(&source_id);
    let before = snapshot()?;
    let target = before
        .entries
        .iter()
        .find(|e| e.kind == "turn.end")
        .unwrap()
        .id
        .clone();
    let erased = before
        .entries
        .iter()
        .rfind(|e| e.kind == "input")
        .unwrap()
        .id
        .clone();
    let filler_before = store.inspect(&filler_id)?;
    // Allow for the list separator and the extra copy reference on the new setting.
    let filler_overhead = serde_json::to_vec(filler_before.entries.last().unwrap())?.len() + 128;
    let summed = || -> anyhow::Result<usize> {
        Ok(serde_json::to_vec(&snapshot()?)?.len()
            + serde_json::to_vec(&store.inspect(&filler_id)?)?.len())
    };
    let stored = summed()?;
    let limits = |ordinary| {
        let control = fixture.control_headroom_bytes;
        let shared = ByteCapacity {
            storage: ordinary as u64 + control,
            control,
            buffered: 1_000_000,
        };
        ByteLimits {
            session: ByteCapacity {
                storage: 1_000_000,
                ..shared
            },
            tenant: shared,
            agent: shared,
        }
    };
    let options = MoveOptions { rewind: true };
    let agent = build(&project)?.byte_limits(limits(stored)).build().await?;
    let writer = agent.open_session(&source_id).await?;
    agent.open_session(&filler_id).await?;
    assert_eq!(
        writer.move_to(&target).await.unwrap_err().code(),
        Code::Busy
    );
    assert_eq!(
        writer
            .move_to_with(&target, options.clone())
            .await
            .unwrap_err()
            .code(),
        Code::Busy
    );
    assert_eq!(std::fs::read_to_string(&file)?, "current");
    assert_eq!(
        serde_json::to_vec(&snapshot()?)?,
        serde_json::to_vec(&before)?
    );
    agent.close().await?;

    let ordinary = stored + fixture.ordinary_write_bytes;
    let agent = build(&project)?
        .byte_limits(limits(ordinary))
        .build()
        .await?;
    let writer = agent.open_session(&source_id).await?;
    let filler = agent.open_session(&filler_id).await?;
    env.pause_target.store(true, Ordering::Relaxed);
    env.fail_target
        .store(mode != Restore::Complete, Ordering::Relaxed);
    env.fail_undo
        .store(mode == Restore::Recover, Ordering::Relaxed);
    let (result, spare) = {
        let rewind = writer.move_to_with(&target, options);
        tokio::pin!(rewind);
        tokio::select! {
            result = &mut rewind => panic!("rewind did not reach restore: {result:?}"),
            () = env.entered.notified() => {}
        }
        assert!(snapshot()?.unresolved_rewind().is_some());
        let remaining = ordinary - summed()?;
        // Rust encodes the title in both the settings snapshot and the entry.
        let title = json!("x".repeat((remaining - filler_overhead) / 2));
        filler.set_setting("title", title.clone())?;
        let spare = ordinary - summed()?;
        assert_eq!(
            filler.set_setting("title", title).unwrap_err().code(),
            Code::Busy
        );
        env.resume.notify_one();
        (rewind.await, spare)
    };
    match mode {
        Restore::Complete => {
            result?;
        }
        Restore::Compensate => assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("original files restored")
        ),
        Restore::Recover => {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("undo is unresolved")
            );
            let journal = snapshot()?;
            assert_eq!(
                journal
                    .unresolved_rewind()
                    .unwrap()
                    .content
                    .as_ref()
                    .unwrap()["restore"]["point"],
                "current"
            );
            env.fail_undo.store(false, Ordering::Relaxed);
        }
    }
    writer.close().await?;
    let reopened = agent.open_session(&source_id).await?;
    let after = snapshot()?;
    assert!(after.unresolved_rewind().is_none());
    let positions = &after.entries[before.entries.len()..];
    assert!(
        positions[1..]
            .iter()
            .all(|entry| serde_json::to_vec(entry).unwrap().len() > spare),
        "settlement records must not fit the remaining ordinary space"
    );
    assert_eq!(
        positions.len(),
        if mode == Restore::Complete { 2 } else { 3 }
    );
    assert_eq!(
        after.position,
        if mode == Restore::Complete {
            Some(target)
        } else {
            before.position
        }
    );
    assert_eq!(
        std::fs::read_to_string(&file)?,
        if mode == Restore::Complete {
            "target"
        } else {
            "current"
        }
    );
    assert!(
        reopened
            .erase(vec![erased.clone()])
            .await?
            .erased
            .iter()
            .any(|copy| copy.id == erased)
    );
    agent.close().await?;
    Ok(())
}
