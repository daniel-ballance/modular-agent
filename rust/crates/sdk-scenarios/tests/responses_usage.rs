//! Responses usage is consistent across the API-key and subscription Providers.
use modular_agent::{
    Agent, ChatGptOptions, GrokOptions, Result, chatgpt, grok, subscription_logins,
};
use modular_agent_openai::openai;
use opentelemetry::global;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use serde_json::json;

#[path = "../../sdk/tests/fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

// This suite uses only the HTTP replay and file helpers, not the sign-in fixtures.
#[allow(dead_code)]
#[path = "../../sdk/tests/subscription_support/mod.rs"]
mod subscription_support;
use subscription_support::{Http, private_file};

#[tokio::test]
async fn responses_usage_keeps_cached_input_separate_in_messages_and_telemetry() -> Result<()> {
    let spans = InMemorySpanExporter::default();
    let tracer = SdkTracerProvider::builder()
        .with_simple_exporter(spans.clone())
        .build();
    global::set_tracer_provider(tracer.clone());
    let cases = [
        (Some(700), Some((300, 700, 1000))),
        (None, Some((1000, 0, 1000))),
        (Some(1200), Some((0, 1200, 1200))),
        (None, None),
    ];
    let project = git_project();
    let auth = tempfile::tempdir()?;
    let logins = subscription_logins(auth.path().join("auth.json"));
    private_file(
        &auth.path().join("auth.json"),
        &serde_json::to_vec(&json!({"logins":{
            "chatgpt":{"type":"oauth","access":"fixture","refresh":"fixture","expires":4_000_000_000_000_u64,"account":"fixture-account"},
            "grok":{"type":"oauth","access":"fixture","refresh":"fixture","expires":4_000_000_000_000_u64}
        }}))?,
    );
    for model in ["chatgpt/gpt-6.1-sol", "grok/grok-4.3", "openai/gpt-6-luna"] {
        let responses = cases.map(|(cached, expected)| {
            let mut response = json!({"status":"completed","output":[
                {"type":"message","content":[{"type":"output_text","text":"hello"}]}
            ]});
            if expected.is_some() {
                response["usage"] = json!({"input_tokens":1000,"output_tokens":2});
                if let Some(cached) = cached {
                    response["usage"]["input_tokens_details"] = json!({"cached_tokens":cached});
                }
            }
            let event = json!({"type":"response.completed","response":response});
            ("/responses", 200, format!("data: {event}\n\n"))
        });
        let http = Http::start(responses.into()).await;
        let endpoint = http.url("/responses");
        let builder = Agent::builder().project(project.path()).model(model);
        let builder = match model.split_once('/').unwrap().0 {
            "chatgpt" => builder.provider(
                chatgpt(ChatGptOptions::new(logins.clone()))?
                    .with_test_endpoints(&endpoint, &http.url("/token"))?,
            ),
            "grok" => builder.provider(
                grok(GrokOptions::new(logins.clone()))?
                    .with_test_endpoints(&endpoint, &http.url("/token"))?,
            ),
            _ => builder.provider(openai().with_test_endpoint(&endpoint)?),
        };
        let agent = builder.build().await?;
        for (cached, expected) in cases {
            let session = agent.session().await?;
            assert_eq!(session.prompt("check usage").await?.text, "hello");
            let reply = session
                .history()
                .await?
                .into_iter()
                .find(|entry| entry["kind"] == "response")
                .unwrap();
            let usage = expected.map(|(input, cache_read, _)| {
                json!({"input":input,"cacheRead":cache_read,"cacheWrite":0,"output":2,"cost":0.0})
            });
            assert_eq!(
                reply["message"].get("usage"),
                usage.as_ref(),
                "{model}, {cached:?}"
            );
            let finished = spans.get_finished_spans().unwrap();
            let chat = finished
                .iter()
                .find(|span| {
                    span.name.starts_with("chat ")
                        && span.attributes.iter().any(|attr| {
                            attr.key.as_str() == "gen_ai.conversation.id"
                                && attr.value == session.id().to_owned().into()
                        })
                })
                .unwrap();
            let attributes: std::collections::BTreeMap<_, _> = chat
                .attributes
                .iter()
                .filter(|attr| attr.key.as_str().starts_with("gen_ai.usage."))
                .map(|attr| (attr.key.as_str(), attr.value.clone()))
                .collect();
            let mut expected_attributes = std::collections::BTreeMap::new();
            if let Some((_, cache_read, total)) = expected {
                expected_attributes.insert("gen_ai.usage.input_tokens", total.into());
                expected_attributes.insert("gen_ai.usage.output_tokens", 2_i64.into());
                if cache_read > 0 {
                    expected_attributes
                        .insert("gen_ai.usage.cache_read.input_tokens", cache_read.into());
                }
            }
            assert_eq!(attributes, expected_attributes, "{model}, {cached:?}");
        }
        http.done.await.unwrap();
        agent.close().await?;
    }
    tracer.shutdown().unwrap();
    Ok(())
}
