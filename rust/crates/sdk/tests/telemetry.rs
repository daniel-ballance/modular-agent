use agent_api::{HistoryStore, portable, telemetry};
use modular_agent::{
    Durability, Outcome, Result, Timing, Tool, ToolContext,
    testing::{restart, test_agent},
};
use opentelemetry::{
    global,
    trace::{SpanId, SpanKind, Status},
};
use opentelemetry_sdk::{
    error::{OTelSdkError, OTelSdkResult},
    trace::{InMemorySpanExporter, Sampler, SdkTracerProvider, SpanData, SpanExporter},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Debug, Default)]
struct FailingExporter(Arc<AtomicUsize>);
impl SpanExporter for FailingExporter {
    async fn export(&self, _: Vec<SpanData>) -> OTelSdkResult {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err(OTelSdkError::InternalFailure("exporter-sentinel".into()))
    }
}

fn attr<'a>(span: &'a SpanData, key: &str) -> Option<&'a opentelemetry::Value> {
    span.attributes
        .iter()
        .find(|a| a.key.as_str() == key)
        .map(|a| &a.value)
}

// One test owns the process-wide providers, including the initial no-op case.
#[tokio::test]
async fn metadata_only_work_and_recovery() -> Result<()> {
    let raw_parent = json!({"traceparent":"00-aabbccddaabbccddaabbccddaabbccdd-1122334455667788-01", "baggage":"baggage-sentinel", "tracestate":"vendor=state-sentinel"});
    let parent = telemetry::extract(&raw_parent).unwrap();
    let noop_dir = tempfile::tempdir()?;
    let noop = test_agent()
        .data_dir(noop_dir.path())
        .durability(Durability::Durable)
        .script(json!([{"text":"no-sdk-result"}]))
        .build()
        .await?;
    assert_eq!(noop.declaration()?["telemetry"], 1);
    let session = noop.session().await?;
    assert_eq!(
        telemetry::within(parent.clone(), session.prompt("no-sdk-input"))
            .await?
            .text,
        "no-sdk-result"
    );
    assert!(
        !session
            .history()
            .await?
            .iter()
            .any(|e| e["data"].get("traceContext").is_some())
    );
    noop.close().await?;

    let exporter = InMemorySpanExporter::default();
    let failing = FailingExporter::default();
    let failures = failing.0.clone();
    let provider = SdkTracerProvider::builder()
        .with_sampler(Sampler::AlwaysOn)
        .with_simple_exporter(exporter.clone())
        .with_simple_exporter(failing)
        .build();
    global::set_tracer_provider(provider.clone());
    let dir = tempfile::tempdir()?;
    let store = history_fs::FileHistory::new(dir.path())?;
    let started = Arc::new(Notify::new());
    let runs = Arc::new(AtomicUsize::new(0));
    let hold = Tool::new("hold", "definition-sentinel").run({
        let (started, runs) = (started.clone(), runs.clone());
        move |input: Value, _: ToolContext| {
            let (started, runs) = (started.clone(), runs.clone());
            async move {
                assert_eq!(input, json!({"value":"argument-sentinel"}));
                runs.fetch_add(1, Ordering::Relaxed);
                started.notify_one();
                std::future::pending::<()>().await;
                Ok("result-sentinel")
            }
        }
    });
    let agent = test_agent().agent_name("fixture").data_dir(dir.path()).durability(Durability::Durable)
        .history(modular_agent::History::from_store(history_fs::FileHistory::new(dir.path())?, true))
        .tool(hold).script(json!([
            {"toolCalls":[{"name":"hold","input":{"value":"argument-sentinel"}}], "usage":{"input":9,"output":2}},
            {"text":"completion-sentinel"}
        ])).build().await?;
    let session = agent.session().await?;
    let id = session.id().to_owned();
    telemetry::within(parent, session.send("prompt-sentinel", Timing::Now)).await?;
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .expect("tool did not start");

    let original = store.load(&id)?;
    let original = original
        .entries
        .iter()
        .find(|e| e.kind == "turn.start")
        .unwrap();
    let saved = original.content.as_ref().unwrap()["traceContext"]["traceparent"]
        .as_str()
        .unwrap()
        .to_owned();
    let turn_id = original.scope.turn.as_ref().unwrap();
    assert_eq!(&saved[3..35], "aabbccddaabbccddaabbccddaabbccdd");
    assert_ne!(&saved[36..52], "1122334455667788");
    let agent = restart(agent).await?;
    let reopened = agent.open_session(&id).await?;
    assert_eq!(
        reopened
            .last_turn()
            .await?
            .unwrap()
            .outcome
            .as_ref()
            .map(Outcome::kind),
        Some("completed")
    );
    assert_eq!(runs.load(Ordering::Relaxed), 1);
    let loaded = store.load(&id)?;
    let segment = loaded
        .entries
        .iter()
        .find(|e| e.kind == telemetry::TURN_TRACE)
        .unwrap();
    let fresh = segment.content.as_ref().unwrap()["traceContext"]["traceparent"]
        .as_str()
        .unwrap();
    assert_eq!(segment.scope.turn.as_ref(), Some(turn_id));
    assert_eq!(&fresh[3..35], &saved[3..35]);
    assert_ne!(&fresh[36..52], &saved[36..52]);
    assert!(!segment.visible);
    assert!(
        !portable::public_entry(segment, &loaded)?
            .as_object()
            .unwrap()
            .contains_key("data")
    );
    let fork = reopened.fork()?;
    assert!(!store.load(fork.id())?.entries.iter().any(|e| {
        e.kind == telemetry::TURN_TRACE
            || e.content
                .as_ref()
                .is_some_and(|v| v.get("traceContext").is_some())
    }));
    agent.close().await?;
    assert!(failures.load(Ordering::Relaxed) > 0);

    let spans = exporter.get_finished_spans().unwrap();
    assert!(!format!("{spans:?}").contains("-sentinel"));
    let resumed = spans
        .iter()
        .find(|s| attr(s, "modular_agent.turn.resumed") == Some(&true.into()))
        .unwrap();
    assert_eq!(resumed.name, "invoke_agent fixture");
    assert_eq!(resumed.span_kind, SpanKind::Internal);
    assert_eq!(resumed.status, Status::Unset);
    assert_eq!(resumed.links.links.len(), 1);
    assert_eq!(
        resumed.links.links[0].span_context.span_id(),
        resumed.parent_span_id
    );
    assert_eq!(
        resumed.parent_span_id,
        SpanId::from_hex(&saved[36..52]).unwrap()
    );
    assert_eq!(
        attr(resumed, "modular_agent.turn.id"),
        Some(&turn_id.clone().into())
    );
    assert_eq!(attr(resumed, "gen_ai.agent.name"), Some(&"fixture".into()));
    let admission = spans
        .iter()
        .find(|s| s.name == "modular_agent.input.admit")
        .unwrap();
    assert_eq!(
        admission.parent_span_id,
        SpanId::from_hex("1122334455667788").unwrap()
    );
    let chat = spans.iter().find(|s| s.name.starts_with("chat ")).unwrap();
    let step = spans
        .iter()
        .find(|s| s.span_context.span_id() == chat.parent_span_id)
        .unwrap();
    assert_eq!(step.name, "modular_agent.step");
    assert_eq!(attr(chat, "gen_ai.conversation.id"), Some(&id.into()));
    assert!(
        spans
            .iter()
            .any(|s| s.name == "execute_tool hold"
                && s.parent_span_id == step.span_context.span_id())
    );
    assert!(
        spans
            .iter()
            .any(|s| s.name == "modular_agent.history.commit"
                && s.parent_span_id == resumed.span_context.span_id())
    );
    retry_has_its_own_step(&exporter).await?;
    Ok(())
}

async fn retry_has_its_own_step(exporter: &InMemorySpanExporter) -> Result<()> {
    use modular_agent::{
        Agent, AssistantMessage, ModelDecision, ModelError, ModelErrorKind, ModelInfo, ModelRef,
        ModelRequest, Order, Plugin, Provider, ProviderContext,
        testing::{memory_environment, scripted_provider},
    };

    struct Retry<P>(P, AtomicUsize);
    #[modular_agent::async_trait]
    impl<P: Provider> Provider for Retry<P> {
        fn id(&self) -> &str {
            self.0.id()
        }
        fn models(&self) -> Vec<ModelInfo> {
            self.0.models()
        }
        async fn request(
            &self,
            model: ModelRef,
            request: ModelRequest,
            cx: ProviderContext,
        ) -> Result<AssistantMessage> {
            if self.1.fetch_add(1, Ordering::Relaxed) == 0 {
                return Ok(ModelError::new(ModelErrorKind::Temporary, "offline failure").failed());
            }
            self.0.request(model, request, cx).await
        }
    }

    let dir = tempfile::tempdir()?;
    let agent = Agent::builder()
        .agent_name("retry-fixture")
        .project(dir.path())
        .environment(memory_environment())
        .provider(Retry(
            scripted_provider(json!([{"text":"retried"}])),
            AtomicUsize::new(0),
        ))
        .model("scripted/script")
        .plugin(
            Plugin::new("retry")
                .on_model_failed_with(Order::First, |_| async { Ok(ModelDecision::Retry(None)) }),
        )
        .build()
        .await?;
    let session = agent.session().await?;
    let result = session.prompt("try again").await?;
    assert_eq!(result.text, "retried");
    agent.close().await?;

    let spans = exporter.get_finished_spans().unwrap();
    let session_id = opentelemetry::Value::from(session.id().to_owned());
    let turn_id = opentelemetry::Value::from(result.turn_id.unwrap());
    let scoped: Vec<_> = spans
        .iter()
        .filter(|span| {
            attr(span, "gen_ai.conversation.id") == Some(&session_id)
                && attr(span, "modular_agent.turn.id") == Some(&turn_id)
        })
        .collect();
    let turn = scoped
        .iter()
        .find(|span| span.name == "invoke_agent retry-fixture")
        .unwrap();
    let steps: Vec<_> = scoped
        .iter()
        .filter(|span| span.name == "modular_agent.step")
        .collect();
    let attempts: Vec<_> = scoped
        .iter()
        .filter(|span| span.name == "chat script")
        .collect();
    assert_eq!(steps.len(), 2);
    assert_eq!(attempts.len(), 2);
    let first = attempts
        .iter()
        .find(|span| matches!(span.status, Status::Error { .. }))
        .unwrap();
    let second = attempts
        .iter()
        .find(|span| span.span_context != first.span_context)
        .unwrap();
    let first_id = attr(first, "modular_agent.step.id").unwrap();
    let second_id = attr(second, "modular_agent.step.id").unwrap();
    assert_ne!(first_id, second_id);
    for attempt in [first, second] {
        let id = attr(attempt, "modular_agent.step.id");
        let step = steps
            .iter()
            .find(|span| attr(span, "modular_agent.step.id") == id)
            .unwrap();
        assert_eq!(
            step.parent_span_id,
            turn.span_context.span_id(),
            "both steps are children of the turn"
        );
        assert_eq!(attempt.parent_span_id, step.span_context.span_id());
    }
    let retry_step = steps
        .iter()
        .find(|span| attr(span, "modular_agent.step.id") == Some(second_id))
        .unwrap();
    let retry_commits: Vec<_> = scoped
        .iter()
        .filter(|span| {
            span.name == "modular_agent.history.commit"
                && attr(span, "modular_agent.step.id") == Some(second_id)
        })
        .collect();
    assert!(
        retry_commits.len() > 1,
        "the retry commits more than just the attempt intent"
    );
    assert!(retry_commits.iter().all(|span| span.parent_span_id
        == retry_step.span_context.span_id()
        || span.parent_span_id == second.span_context.span_id()));
    Ok(())
}
