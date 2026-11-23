"""Metadata-only telemetry. The embedding app owns providers and exporters."""

import re
from contextlib import contextmanager, nullcontext
from time import monotonic

from opentelemetry import context, metrics, trace
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

SCOPE = "modular_agent"
TURN_TRACE = "modular-agent.turnTrace"
DISCLOSURE = "modular-agent.disclosure"
TRACE = TraceContextTextMapPropagator()
_EMPTY = context.Context()
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}\Z")
_STEP = context.create_key("modular_agent.step")
_SCOPE = context.create_key("modular_agent.work")
_NULL = trace.INVALID_SPAN


def name(value):
    return value if isinstance(value, str) and _NAME.fullmatch(value) else None


def current():
    return trace.set_span_in_context(trace.get_current_span(), _EMPTY)


def extract(carrier):
    if isinstance(carrier, dict) and isinstance(carrier.get("traceparent"), str):
        # Vendor state is not allowed by default. Never extract baggage.
        return TRACE.extract({"traceparent": carrier["traceparent"]}, context=_EMPTY)
    return _EMPTY


def inject(ctx=None):
    carrier = {}
    TRACE.inject(carrier, context=ctx)
    return {k: v for k, v in carrier.items() if k == "traceparent"}


def valid(ctx):
    return trace.get_current_span(ctx).get_span_context().is_valid


def same_trace(parent, candidate):
    p = trace.get_current_span(parent).get_span_context()
    c = trace.get_current_span(candidate).get_span_context()
    return p.is_valid and c.is_valid and p.trace_id == c.trace_id


def saved_turn_context(entries, sid, turn):
    for entry in reversed(entries):
        if (
            entry.get("session") != sid
            or entry.get("turn") != turn
            or entry.get("kind") not in {"turn_start", TURN_TRACE}
            or entry.get("fork_source")
            or entry.get("erased")
            or entry.get("visible")
            or (entry["kind"] == TURN_TRACE and entry.get("writer") != "@harness")
        ):
            continue
        data = entry.get("data") or {}
        if not data.get("erased") and valid(saved := extract(data.get("traceContext"))):
            return saved
    return _EMPTY


def link(ctx):
    return [trace.Link(trace.get_current_span(ctx).get_span_context())] if valid(ctx) else []


def segment(span, parent):
    own = span.get_span_context()
    if not own.is_valid or own == trace.get_current_span(parent).get_span_context():
        return {}
    return {"traceContext": inject(own_context(span))}


def project_entry(entry):
    if entry["kind"] == TURN_TRACE:
        return {k: v for k, v in entry.items() if k not in {"data", "content", "message"}}
    if entry["kind"] in {"turnStart", "turn_start"} and "traceContext" in (entry.get("data") or {}):
        return {**entry, "data": {k: v for k, v in entry["data"].items() if k != "traceContext"}}
    return entry


def own_context(span):
    return trace.set_span_in_context(span, _EMPTY)


def scoped_context(span, sid, turn, step):
    return context.set_value(_SCOPE, (sid, turn, step), own_context(span))


@contextmanager
def use(ctx):
    token = context.attach(ctx)
    try:
        yield
    finally:
        context.detach(token)


def attrs(sid=None, turn=None, step=None, **attributes):
    owner, active_turn, active_step = context.get_value(_SCOPE) or (None, None, None)
    if sid is None:
        sid = owner
    if sid == owner:
        turn = turn or active_turn
        if turn == active_turn:
            step = step or active_step
    return {
        k: v
        for k, v in {
            "gen_ai.conversation.id": sid,
            "modular_agent.turn.id": turn,
            "modular_agent.step.id": step,
            **attributes,
        }.items()
        if v is not None
    }


def set_attrs(span, attributes):
    try:
        span.set_attributes(attributes)
    except Exception:
        pass


def error(span, kind):
    set_attrs(span, {"error.type": kind})
    try:
        span.set_status(trace.StatusCode.ERROR)
    except Exception:
        pass


def begin(label, attributes, *, parent=None, kind=trace.SpanKind.INTERNAL, links=()):
    try:
        return trace.get_tracer(SCOPE).start_span(
            label,
            context=parent,
            kind=kind,
            attributes=attributes,
            links=links,
            record_exception=False,
            set_status_on_exception=False,
        )
    except Exception:
        return _NULL


def end(span):
    try:
        span.end()
    except Exception:
        pass


@contextmanager
def span(label, attributes=None, *, parent=None, kind=trace.SpanKind.INTERNAL, links=()):
    attributes = attributes or attrs()
    operation = begin(label, attributes, parent=parent, kind=kind, links=links)
    ctx = trace.set_span_in_context(operation, _EMPTY)
    if steps := context.get_value(_STEP):
        ctx = context.set_value(_STEP, steps, ctx)
    # Preserve safe work identifiers across explicit parent changes.
    ctx = context.set_value(
        _SCOPE,
        (
            attributes.get("gen_ai.conversation.id"),
            attributes.get("modular_agent.turn.id"),
            attributes.get("modular_agent.step.id"),
        ),
        ctx,
    )
    with use(ctx):
        try:
            yield operation
        except Exception:
            error(operation, "operation_failed")
            raise
        finally:
            end(operation)


def event(label, attributes):
    try:
        trace.get_current_span().add_event(label, attributes)
    except Exception:
        pass


class Steps:
    """A step stays current through preparation, inference and tool settlement."""

    def __init__(self, sid, turn):
        self.sid = sid
        self.turn = turn
        self.active = None
        self.scope = None

    @contextmanager
    def track(self):
        token = context.attach(context.set_value(_STEP, self))
        try:
            yield
        finally:
            self.close()
            context.detach(token)

    def close(self):
        if self.scope is not None:
            self.scope.__exit__(None, None, None)
            self.scope = self.active = None

    def start(self, step):
        if self.active == step:
            return
        self.close()
        self.active = step
        self.scope = span("modular_agent.step", attrs(self.sid, self.turn, step))
        self.scope.__enter__()


def step_start(step):
    if (steps := context.get_value(_STEP)) is not None:
        steps.start(step)


def step_end():
    if (steps := context.get_value(_STEP)) is not None:
        steps.close()


def question_attrs(sid, question):
    return attrs(
        sid,
        question.get("turn"),
        question.get("step"),
        **{
            "modular_agent.question.id": question["id"],
            "modular_agent.question.kind": question["kind"],
        },
    )


def question_event(action, sid, question, disposition=None):
    a = question_attrs(sid, question)
    if disposition is not None:
        a["modular_agent.question.disposition"] = disposition
    event("modular_agent.question." + action, a)


def question_answer(sid, question):
    if trace.get_current_span().is_recording():
        return nullcontext()
    return span("modular_agent.question.answer", question_attrs(sid, question))


def tool_attrs(sid, turn, step, call, registered=None):
    return attrs(
        sid,
        turn,
        step,
        **{
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name(registered),
            "modular_agent.tool.call.id": call.get("id"),
            "modular_agent.tool.parent_call.id": call.get("parentCallId"),
        },
    )


def tool_status(result):
    if result.get("open"):
        return "pending"
    return {
        "ok": "completed",
        "completed": "completed",
        "success": "completed",
        "failed": "failed",
        "cancelled": "cancelled",
        "refused": "refused",
        "outcome_unknown": "outcomeUnknown",
    }.get(result.get("status"), "failed")


def tool_disposition(sid, turn, step, call, definition, result):
    event(
        "modular_agent.tool.disposition",
        {
            **tool_attrs(sid, turn, step, call, definition and definition["name"]),
            "modular_agent.tool.status": tool_status(result),
        },
    )


# Only known metadata values are exported. Never export diagnostics or exceptions.
_FINISH = {
    "finished": "stop",
    "tools": "tool_calls",
    "output_limit": "length",
    "refused": "content_filter",
    "failed": "error",
    "aborted": "aborted",
    "cancelled": "cancelled",
}
_ERRORS = {"temporary", "credentials", "contextTooLarge", "other", "invalidRequest", "rateLimit"}
_VENDOR = {"chatgpt": "openai", "claude": "anthropic", "grok": "xai"}


async def inference(provider, data, invoke, *, local=False):
    access = data.get("access") or {}
    model = name((access.get("id") or "").removeprefix(provider + "/"))
    dimensions = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": _VENDOR.get(provider, provider),
        **({"gen_ai.request.model": model} if model else {}),
    }
    a = attrs(data.get("session"), data.get("turn"), data.get("step"), **dimensions)
    a["modular_agent.provider.id"] = provider
    started = monotonic()
    usage = {}
    if type(data.get("stream")) is bool:
        a["gen_ai.request.stream"] = data["stream"]
    with span(
        "chat " + model if model else "chat",
        a,
        kind=trace.SpanKind.INTERNAL if local else trace.SpanKind.CLIENT,
    ) as operation:
        try:
            result = await invoke()
            if result.get("stop") == "failed":
                code = (result.get("error") or {}).get("kind")
                dimensions["error.type"] = code if code in _ERRORS else "provider_failed"
                error(operation, dimensions["error.type"])
            if reason := _FINISH.get(result.get("stop")):
                set_attrs(operation, {"gen_ai.response.finish_reasons": (reason,)})
            for key in (
                "input_tokens",
                "output_tokens",
                "cache_read",
                "cache_write",
                "reasoning_tokens",
            ):
                value = (result.get("usage") or {}).get(key)
                if type(value) is int and 0 <= value < 2**63:
                    usage[key] = value
            usage_attributes = {
                "cache_read": "cache_read.input_tokens",
                "cache_write": "cache_creation.input_tokens",
                "reasoning_tokens": "reasoning.output_tokens",
            }
            set_attrs(
                operation,
                {f"gen_ai.usage.{usage_attributes.get(k, k)}": v for k, v in usage.items()},
            )
            response_model = result.get("model")
            if isinstance(response_model, dict):
                response_model = response_model.get("id")
            if model and response_model == model:
                set_attrs(operation, {"gen_ai.response.model": model})
            return result
        except Exception:
            dimensions["error.type"] = "provider_failed"
            raise
        finally:
            try:
                meter = metrics.get_meter(SCOPE)
                meter.create_histogram("gen_ai.client.inference.duration", unit="s").record(
                    monotonic() - started,
                    attributes=dimensions,
                )
                for key in ("input_tokens", "output_tokens"):
                    if usage.get(key, 0) > 0:
                        meter.create_counter(
                            f"gen_ai.client.inference.usage.{key}", unit="{token}"
                        ).add(
                            usage[key],
                            attributes={**dimensions, "gen_ai.token.modality": "unknown"},
                        )
            except Exception:
                pass
