use modular_agent::{
    AssistantMessage, Code, Durability, Job, JobOwner, ModelInfo, ModelRef, ModelRequest, Plugin,
    Provider, ProviderContext, ProviderSupport, Result, Tool, ToolContext, async_trait,
    file_history, testing::test_agent,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct Owner(bool, Arc<AtomicUsize>);
#[async_trait]
impl JobOwner for Owner {
    async fn cancel(&self, _job: Job, _: modular_agent::HookContext) -> Result<()> {
        self.1.fetch_add(1, Ordering::SeqCst);
        if self.0 {
            Ok(())
        } else {
            Err(modular_agent::Error::msg("could not stop"))
        }
    }
}

#[tokio::test]
async fn job_cleanup_is_required_for_direct_and_pending_erasure() -> Result<()> {
    for pending in [false, true] {
        for confirm in [false, true] {
            let root = tempfile::tempdir()?;
            let history = file_history(root.path().join("history"))?;
            let cancels = Arc::new(AtomicUsize::new(0));
            let build = || {
                let cancels = cancels.clone();
                let plugin = Plugin::new("erasure-job")
                    .setup(move |r| r.jobs(Owner(confirm, cancels.clone())))
                    .tool(Tool::new("job", "Start work").run(
                        |_: Value, cx: ToolContext| async move {
                            Ok(cx.start_job("work", Value::Null, None).await?.id)
                        },
                    ));
                test_agent()
                    .project(root.path())
                    .durability(Durability::Kept)
                    .history(history.clone())
                    .plugin(plugin)
                    .script(json!([{"text":"seed"}]))
                    .build()
            };
            let a = build().await?;
            let source = a.session().await?;
            source.prompt("erase this").await?;
            let target = source
                .history()
                .await?
                .into_iter()
                .find(|e| e["kind"] == "input")
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let b = if pending { Some(build().await?) } else { None };
            let dest = if let Some(b) = &b {
                let fork = source.fork()?;
                fork.close().await?;
                b.open_session(fork.id()).await?
            } else {
                source.clone()
            };
            let job = dest.call_tool("job", json!({})).await?;
            assert_eq!(job.status, modular_agent::ToolStatus::Completed);
            let report = source.erase(vec![target]).await?;
            if !pending && !confirm {
                assert!(!report.pending.is_empty());
            }
            let found = dest.history().await;
            if pending {
                assert_eq!(found.err().unwrap().code(), Code::Unavailable);
                let result = b
                    .as_ref()
                    .unwrap()
                    .reconcile_erasure(modular_agent::ReconcileErasureOptions {
                        sessions: vec![dest.id().into()],
                        discover: false,
                    })
                    .await?;
                assert_eq!(result[0].state, modular_agent::ErasureRetryState::Busy);
                assert_eq!(cancels.load(Ordering::SeqCst), 0);
            } else if confirm {
                let found = found?;
                assert!(found.iter().any(|e| e["kind"] == "jobEnded"));
                assert!(!json!(found).to_string().contains("erase this"));
            } else {
                assert!(found.is_err());
            }
            assert_eq!(
                cancels.load(Ordering::SeqCst),
                if !pending && !confirm { 2 } else { 1 }
            );
            let _ = a.close().await;
            if let Some(b) = b {
                let _ = b.close().await;
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn pending_job_cleanup_retries_after_writer_handoff() -> Result<()> {
    for (close_before_erase, served) in [(true, false), (false, false), (true, true)] {
        let root = tempfile::tempdir()?;
        let history = file_history(root.path().join("history"))?;
        let cancels = Arc::new(AtomicUsize::new(0));
        let build = |confirm| {
            let cancels = cancels.clone();
            let plugin = Plugin::new("erasure-job")
                .setup(move |r| r.jobs(Owner(confirm, cancels.clone())))
                .tool(
                    Tool::new("job", "Start work").run(|_: Value, cx: ToolContext| async move {
                        Ok(cx
                            .start_job("work", json!("private job detail"), None)
                            .await?
                            .id)
                    }),
                );
            let builder = test_agent()
                .project(root.path())
                .durability(Durability::Kept)
                .history(history.clone())
                .script(json!([{"text":"seed"}]));
            if served {
                builder.over_wire(plugin)
            } else {
                builder.plugin(plugin)
            }
            .build()
        };
        let first = build(false).await?;
        let source = first.session().await?;
        source.prompt("erase this").await?;
        let target = source
            .history()
            .await?
            .into_iter()
            .find(|e| e["kind"] == "input")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let fork = source.fork()?;
        let fork = if served {
            fork.close().await?;
            first.open_session(fork.id()).await?
        } else {
            fork
        };
        assert_eq!(
            fork.call_tool("job", json!({})).await?.status,
            modular_agent::ToolStatus::Completed
        );
        let source_id = source.id().to_owned();
        let fork_id = fork.id().to_owned();
        if close_before_erase {
            first.close().await?;
            assert_eq!(cancels.load(Ordering::SeqCst), 1);
        }
        let eraser = if close_before_erase {
            build(false).await?
        } else {
            first
        };
        let source = if close_before_erase {
            eraser.open_session(&source_id).await?
        } else {
            source
        };
        // The SDK redacts cross-session copy IDs from the source's report.
        let report = source.erase(vec![target.clone()]).await?;
        assert!(
            report
                .out_of_reach
                .iter()
                .any(|item| item == "copies in other sessions")
        );
        if close_before_erase {
            assert_eq!(
                eraser.open_session(&fork_id).await.err().unwrap().code(),
                Code::Unavailable
            );
        }
        eraser.close().await?;

        let failing = build(false).await?;
        let before = cancels.load(Ordering::SeqCst);
        assert_eq!(
            failing.open_session(&fork_id).await.err().unwrap().code(),
            Code::Unavailable
        );
        assert_eq!(cancels.load(Ordering::SeqCst), before + 1);
        failing.close().await?;

        let recovering = build(true).await?;
        let before = cancels.load(Ordering::SeqCst);
        let fork = recovering.open_session(&fork_id).await?;
        assert_eq!(cancels.load(Ordering::SeqCst), before + 1);
        let entries = fork.history().await?;
        assert_eq!(
            entries
                .iter()
                .filter(|e| e["kind"] == "jobCleanupUnconfirmed")
                .count(),
            1
        );
        let ends: Vec<_> = entries.iter().filter(|e| e["kind"] == "jobEnded").collect();
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0]["data"]["outcome"], json!({"kind":"cancelled"}));
        assert_eq!(ends[0]["data"]["report"], false);
        assert!(ends[0]["data"]["result"].is_null());
        assert!(!json!(entries).to_string().contains("erase this"));
        let source = recovering.open_session(&source_id).await?;
        assert!(source.erase(vec![target]).await?.pending.is_empty());
        recovering.close().await?;
    }
    Ok(())
}

#[derive(Clone, Default)]
struct TurnBarrier {
    destination: Arc<Mutex<Option<String>>>,
    started: Arc<tokio::sync::Notify>,
    cancelled: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl Provider for TurnBarrier {
    fn id(&self) -> &str {
        "barrier"
    }
    fn models(&self) -> Vec<ModelInfo> {
        let mut models = CachedProvider::default().models();
        models[0].model.provider = self.id().into();
        models
    }
    async fn request(
        &self,
        _: ModelRef,
        _: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        let destination = self.destination.lock().unwrap().as_deref() == Some(cx.session_id());
        if destination {
            self.started.notify_one();
            cx.cancelled().cancelled().await;
            self.cancelled.notify_one();
            return Ok(AssistantMessage::text("must not escape"));
        }
        Ok(AssistantMessage::text("seed"))
    }
}

#[tokio::test]
async fn active_destination_turns_stop_before_direct_erasure_and_reconciliation() -> Result<()> {
    for pending in [false, true] {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let root = tempfile::tempdir()?;
            let history = file_history(root.path().join("history"))?;
            let barrier = TurnBarrier::default();
            let build = || {
                test_agent()
                    .project(root.path())
                    .durability(Durability::Kept)
                    .history(history.clone())
                    .plugin(Plugin::new("barrier").provider(barrier.clone()))
                    .build()
            };
            let a = build().await?;
            let source = a.session().await?;
            source.set_setting("model", json!("barrier/demo"))?;
            source.prompt("erase this").await?;
            let target = source
                .history()
                .await?
                .into_iter()
                .find(|e| e["kind"] == "input")
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let fork = source.fork()?;
            let b = if pending { Some(build().await?) } else { None };
            let dest = if let Some(b) = &b {
                fork.close().await?;
                b.open_session(fork.id()).await?
            } else {
                fork
            };
            *barrier.destination.lock().unwrap() = Some(dest.id().into());
            let prompt = tokio::spawn({
                let dest = dest.clone();
                async move { dest.prompt("running").await }
            });
            barrier.started.notified().await;
            let report = source.erase(vec![target]).await?;
            assert!(!report.erased.is_empty());
            if pending {
                assert!(dest.set_setting("title", json!("not applied")).is_err());
                let operator = b.as_ref().unwrap();
                let reports = operator
                    .reconcile_erasure(modular_agent::ReconcileErasureOptions {
                        sessions: vec![dest.id().into()],
                        discover: false,
                    })
                    .await?;
                assert_eq!(reports[0].state, modular_agent::ErasureRetryState::Busy);
                let _ = dest.cancel().await;
                let _ = prompt.await;
                operator.close().await?;
                a.close().await?;
                return Ok(());
            }
            let rows = dest.history().await?;
            assert!(!json!(rows).to_string().contains("must not escape"));
            assert!(!json!(rows).to_string().contains("erase this"));
            // The Runtime may drop its Provider future when it observes cancellation.
            let result = prompt.await.expect("join prompt");
            if let Ok(result) = result {
                assert_ne!(result.text, "must not escape");
            }
            a.close().await?;
            if let Some(b) = b {
                b.close().await?;
            }
            Ok::<_, modular_agent::Error>(())
        })
        .await
        .expect("erasure and turn settled")?;
    }
    Ok(())
}

#[derive(Clone, Default)]
struct CachedProvider(Arc<Mutex<std::collections::BTreeSet<String>>>);
#[async_trait]
impl Provider for CachedProvider {
    fn id(&self) -> &str {
        "local-cache"
    }
    fn models(&self) -> Vec<ModelInfo> {
        vec![ModelInfo {
            model: ModelRef {
                provider: self.id().into(),
                id: "demo".into(),
            },
            context_window: 4096,
            max_output: 256,
            thinking: vec![],
            extra: Default::default(),
        }]
    }
    fn supports(&self) -> ProviderSupport {
        ProviderSupport {
            keeps_state: true,
            safe_to_repeat: false,
        }
    }
    async fn request(
        &self,
        _: ModelRef,
        _: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        let fresh = self.0.lock().unwrap().insert(cx.session_id().into());
        Ok(AssistantMessage::text(if fresh {
            "fresh"
        } else {
            "stale"
        }))
    }
    async fn discard_state(&self, id: &str) -> Result<()> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

#[tokio::test]
async fn local_provider_state_is_discarded_before_acknowledgement_and_across_reopen() -> Result<()>
{
    for pending in [false, true] {
        let root = tempfile::tempdir()?;
        let store = root.path().join("history");
        let history = file_history(&store)?;
        let provider = CachedProvider::default();
        let build = || {
            test_agent()
                .project(root.path())
                .durability(Durability::Kept)
                .history(history.clone())
                .plugin(Plugin::new("local-cache").provider(provider.clone()))
                .build()
        };
        let a = build().await?;
        let source = a.session().await?;
        source.set_setting("model", json!("local-cache/demo"))?;
        assert_eq!(source.prompt("erase this").await?.text, "fresh");
        let target = source
            .history()
            .await?
            .into_iter()
            .find(|e| e["kind"] == "input")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        if pending {
            use agent_api::HistoryStore;
            history_fs::FileHistory::new(&store)?.mark_erasure(source.id(), &[target])?;
            source.history().await?;
        } else {
            assert!(!source.erase(vec![target]).await?.erased.is_empty());
        }
        assert!(provider.0.lock().unwrap().is_empty());
        a.close().await?;
        let b = build().await?;
        assert_eq!(
            b.open_session(source.id())
                .await?
                .prompt("again")
                .await?
                .text,
            "fresh"
        );
        b.close().await?;
    }
    Ok(())
}
