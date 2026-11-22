//! Metadata-only work context. Attach it for each poll, never across an await.
use crate::{
    FailureKind, ModelFailure, ModelInfo, ModelResponse, Scope, ToolCall, ToolStatus, Value, json,
};
pub use opentelemetry::trace::{Link, SpanKind, TraceContextExt};
pub use opentelemetry::{Context, KeyValue};
use opentelemetry::{
    global,
    trace::{SpanContext, SpanId, Status, TraceFlags, TraceId, TraceState, Tracer},
};
use std::{future::Future, time::Instant};

pub const TURN_TRACE: &str = "modular-agent.turnTrace";

pub async fn within<F: Future>(context: Context, future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    std::future::poll_fn(|cx| {
        let _guard = context.clone().attach();
        future.as_mut().poll(cx)
    })
    .await
}

pub fn current() -> Context {
    Context::current()
}

/// Copy only a valid parent. Vendor state and baggage are not accepted in this SDK.
pub fn extract(carrier: &Value) -> Option<Context> {
    let parent = carrier.get("traceparent")?.as_str()?;
    let b = parent.as_bytes();
    let hex = |b: &[u8]| {
        b.iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
    };
    if b.len() < 55
        || b[2] != b'-'
        || b[35] != b'-'
        || b[52] != b'-'
        || !hex(&b[..2])
        || !hex(&b[3..35])
        || !hex(&b[36..52])
        || !hex(&b[53..55])
        || &b[..2] == b"ff"
        || (b.len() > 55 && (&b[..2] == b"00" || b[55] != b'-'))
    {
        return None;
    }
    let span = SpanContext::new(
        TraceId::from_hex(&parent[3..35]).ok()?,
        SpanId::from_hex(&parent[36..52]).ok()?,
        TraceFlags::new(u8::from_str_radix(&parent[53..55], 16).ok()?),
        true,
        TraceState::default(),
    );
    span.is_valid()
        .then(|| Context::new().with_remote_span_context(span))
}

pub fn traceparent(cx: &Context) -> Option<String> {
    let span = cx.span();
    let sc = span.span_context();
    sc.is_valid().then(|| {
        format!(
            "00-{}-{}-{:02x}",
            sc.trace_id(),
            sc.span_id(),
            sc.trace_flags().to_u8()
        )
    })
}

pub fn link(cx: &Context) -> Option<Link> {
    let span = cx.span();
    let sc = span.span_context();
    sc.is_valid().then(|| Link::new(sc.clone(), vec![], 0))
}

pub fn carrier(cx: &Context) -> Option<Value> {
    traceparent(cx).map(|traceparent| json!({"traceparent":traceparent}))
}

/// Only use on registered names, never on a payload or diagnostic.
pub fn name(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:/@".contains(&c)))
    .then_some(value)
}

pub fn scope_attributes(scope: Option<&Scope>) -> Vec<KeyValue> {
    let mut attrs = vec![];
    if let Some(s) = scope {
        if !s.session.is_empty() {
            attrs.push(KeyValue::new("gen_ai.conversation.id", s.session.clone()));
        }
        if let Some(turn) = &s.turn {
            attrs.push(KeyValue::new("modular_agent.turn.id", turn.clone()));
        }
        if let Some(step) = &s.step {
            attrs.push(KeyValue::new("modular_agent.step.id", step.clone()));
        }
    }
    attrs
}

pub struct Operation {
    cx: Context,
    on_drop: Option<KeyValue>,
}
impl Operation {
    pub fn new(
        name: impl Into<String>,
        kind: SpanKind,
        scope: Option<&Scope>,
        attrs: Vec<KeyValue>,
    ) -> Self {
        Self::start(name, kind, scope, attrs, &current(), vec![])
    }
    pub fn internal(name: &'static str, scope: &Scope) -> Self {
        Self::new(name, SpanKind::Internal, Some(scope), vec![])
    }
    pub fn start(
        name: impl Into<String>,
        kind: SpanKind,
        scope: Option<&Scope>,
        mut attrs: Vec<KeyValue>,
        parent: &Context,
        links: Vec<Link>,
    ) -> Self {
        attrs.extend(scope_attributes(scope));
        let tracer = global::tracer("modular-agent");
        // A context received from the app can have baggage and other extensions.
        // Use it only to select the parent, and pass a fresh context to parts.
        let span = tracer
            .span_builder(name.into())
            .with_kind(kind)
            .with_attributes(attrs)
            .with_links(links)
            .start_with_context(&tracer, parent);
        Self {
            cx: Context::new().with_span(span),
            on_drop: None,
        }
    }
    pub fn interrupted(mut self, key: &'static str) -> Self {
        self.on_drop = Some(KeyValue::new(key, "interrupted"));
        self
    }
    pub fn outcome(&mut self, key: &'static str, value: &'static str) {
        self.attr(key, value);
        self.on_drop = None;
    }
    pub fn attr(&self, key: &'static str, value: impl Into<opentelemetry::Value>) {
        self.cx.span().set_attribute(KeyValue::new(key, value));
    }
    pub fn error(&self, kind: &'static str) {
        self.attr("error.type", kind);
        self.cx.span().set_status(Status::error(""));
    }
    pub fn context(&self) -> Context {
        self.cx.clone()
    }
    pub fn enter(&self) -> opentelemetry::ContextGuard {
        self.context().attach()
    }
    pub async fn run<F: Future>(&self, f: F) -> F::Output {
        within(self.context(), f).await
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if let Some(attr) = self.on_drop.take() {
            self.cx.span().set_attribute(attr);
        }
        self.cx.span().end();
    }
}

pub fn event(name: &'static str, scope: &Scope, mut attrs: Vec<KeyValue>) {
    attrs.extend(scope_attributes(Some(scope)));
    current().span().add_event(name, attrs);
}

fn inference_failure(kind: &FailureKind) -> Option<&'static str> {
    match kind {
        FailureKind::Temporary => Some("temporary"),
        FailureKind::ContextTooLarge => Some("context_too_large"),
        FailureKind::Credentials => Some("credentials"),
        FailureKind::Refused | FailureKind::Cancelled => None,
        FailureKind::Other => Some("other"),
    }
}

pub async fn inference<E, F>(
    scope: &Scope,
    info: &ModelInfo,
    kind: SpanKind,
    streaming: bool,
    failure: impl FnOnce(&E) -> Option<&'static str>,
    dispatch: F,
) -> Result<ModelResponse, E>
where
    F: Future<Output = Result<ModelResponse, E>>,
{
    let (provider, model) = info
        .name
        .split_once('/')
        .unwrap_or((crate::portable::native_provider(&info.name), &info.name));
    let mut attrs = vec![
        KeyValue::new("gen_ai.operation.name", "chat"),
        KeyValue::new(
            "gen_ai.provider.name",
            match provider {
                "openai" | "chatgpt" => "openai",
                "claude" | "anthropic" => "anthropic",
                "grok" | "xai" => "x_ai",
                p => name(p).unwrap_or("unknown"),
            }
            .to_owned(),
        ),
    ];
    if let Some(model) = name(model) {
        attrs.push(KeyValue::new("gen_ai.request.model", model.to_owned()));
    }
    let mut span_attrs = attrs.clone();
    span_attrs.push(KeyValue::new("gen_ai.request.stream", streaming));
    if let Some(provider) = name(provider) {
        span_attrs.push(KeyValue::new(
            "modular_agent.provider.id",
            provider.to_owned(),
        ));
    }
    let op = Operation::new(
        name(model).map_or_else(|| "chat".into(), |m| format!("chat {m}")),
        kind,
        Some(scope),
        span_attrs,
    );
    let start = Instant::now();
    let result = op.run(dispatch).await;
    let elapsed = start.elapsed().as_secs_f64();
    let meter = global::meter("modular-agent");
    let error = match &result {
        Err(e) => failure(e),
        Ok(r) if r.stop == "failed" => {
            inference_failure(&crate::wire::parse_failure(&crate::wire::response(r)["error"]).kind)
        }
        _ => None,
    };
    if let Some(error) = error {
        op.error(error);
        attrs.push(KeyValue::new("error.type", error));
    }
    meter
        .f64_histogram("gen_ai.client.inference.duration")
        .with_unit("s")
        .build()
        .record(elapsed, &attrs);
    if let Ok(r) = &result {
        if let Some(reason) = match r.stop.as_str() {
            "finished" | "stop" => Some("stop"),
            "tools" | "toolUse" => Some("tool_calls"),
            "length" => Some("length"),
            _ => None,
        } {
            op.attr(
                "gen_ai.response.finish_reasons",
                opentelemetry::Value::Array(opentelemetry::Array::String(vec![reason.into()])),
            );
        }
        attrs.retain(|kv| kv.key.as_str() != "error.type");
        attrs.push(KeyValue::new("gen_ai.token.modality", "unknown"));
        for (attr, metric, count) in [
            (
                "gen_ai.usage.input_tokens",
                "gen_ai.client.inference.usage.input_tokens",
                r.usage.input_tokens,
            ),
            (
                "gen_ai.usage.output_tokens",
                "gen_ai.client.inference.usage.output_tokens",
                r.usage.output_tokens,
            ),
        ] {
            if count > 0 {
                op.attr(attr, count.min(i64::MAX as u64) as i64);
                meter
                    .u64_counter(metric)
                    .with_unit("{token}")
                    .build()
                    .add(count, &attrs);
            }
        }
    }
    result
}

pub fn model_failure(error: &ModelFailure) -> Option<&'static str> {
    inference_failure(&error.kind)
}

pub fn tool_attributes(call: &ToolCall) -> Vec<KeyValue> {
    let mut attrs = vec![
        KeyValue::new("gen_ai.operation.name", "execute_tool"),
        KeyValue::new("modular_agent.tool.call.id", call.id.clone()),
    ];
    if let Some(name) = name(&call.name) {
        attrs.push(KeyValue::new("gen_ai.tool.name", name.to_owned()));
    }
    if let Some(parent) = call.extra["parentCallId"].as_str() {
        attrs.push(KeyValue::new(
            "modular_agent.tool.parent_call.id",
            parent.to_owned(),
        ));
    }
    if call.started_by == "model"
        && let Some(id) = call.extra["id"].as_str()
    {
        attrs.push(KeyValue::new("gen_ai.tool.call.id", id.to_owned()));
    }
    attrs
}

pub fn disposition(scope: &Scope, call: &ToolCall, status: &ToolStatus) {
    let mut attrs = tool_attributes(call);
    attrs.push(KeyValue::new(
        "modular_agent.tool.status",
        crate::wire::status(status),
    ));
    event("modular_agent.tool.disposition", scope, attrs);
}
