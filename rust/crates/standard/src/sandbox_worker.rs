//! `ma subprocess`: the stdio worker launched by `monty-pool`.
//!
//! Adapt Monty's protocol worker to the `ma` binary so installing `ma` does
//! not require a separate `monty` executable. See `monty-runtime/src/subprocess.rs`
//! at v1.6.0 for the upstream stdio worker.
use monty_proto::{
    FrameError, FrameReader, pb,
    worker::{EventSink, HandleOutcome, SessionBudget, Worker},
    write_frame,
};
use std::{io, process::ExitCode};

// The agent never sets a ceiling. In worker mode Monty uses this allocator's
// accounting for its soft limit and its exit code for hard memory failures.
#[global_allocator]
static ALLOC: monty_alloc::LimitedAllocator = monty_alloc::LimitedAllocator;

pub fn run() -> io::Result<ExitCode> {
    let mut input = FrameReader::new(io::stdin().lock());
    let mut sink = Stdout(io::stdout().lock());
    let mut worker = Worker::default();
    // Establish the baseline before decoding the first request. Configure's
    // budget is installed by session_opened before the first feed executes.
    apply_budget(worker.session_budget());
    while let Some(request) = input
        .read::<pb::ClientRequest>()
        .map_err(io::Error::other)?
    {
        match worker
            .handle(request, &mut sink)
            .map_err(io::Error::other)?
        {
            HandleOutcome::Continue => apply_budget(worker.session_budget()),
            HandleOutcome::Shutdown => return Ok(ExitCode::SUCCESS),
            HandleOutcome::Fatal => return Ok(ExitCode::FAILURE),
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn apply_budget(budget: SessionBudget) {
    monty_alloc::set_hard_limit(monty_types::memory_limit_with_headroom(
        budget.max_memory,
        budget.type_check,
    ))
    .expect("the worker uses Monty's allocator");
}

struct Stdout(io::StdoutLock<'static>);

impl EventSink for Stdout {
    fn send(&mut self, event: &pb::WorkerEvent) -> Result<(), FrameError> {
        write_frame(&mut self.0, event)
    }

    fn session_opened(&mut self, budget: SessionBudget) {
        apply_budget(budget);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monty_proto::{
        PROTOCOL_VERSION, ext_result_to_proto, pb::client_request, pb::worker_event,
    };
    use monty_types::{ExtFunctionResult, MontyObject, MontyUuid, NameLookupResult};
    use std::time::Duration;

    #[derive(Default)]
    struct LastEvent(Option<worker_event::Kind>);

    impl EventSink for LastEvent {
        fn send(&mut self, event: &pb::WorkerEvent) -> Result<(), FrameError> {
            self.0 = event.kind.clone();
            Ok(())
        }
    }

    #[test]
    fn worker_clock_excludes_waiting_for_imports_name_lookups_and_calls() {
        use client_request::Kind as Request;
        use worker_event::Kind as Event;
        let mut worker = Worker::default();
        let mut sink = LastEvent::default();
        let mut send = |kind| {
            worker
                .handle(
                    pb::ClientRequest {
                        kind: Some(kind),
                        ..Default::default()
                    },
                    &mut sink,
                )
                .unwrap();
            sink.0.take().unwrap()
        };
        // A feed limit shares the active wall clock but does not reset on
        // resume. A per-turn limit could hide time wrongly charged at a pause.
        let budget = Duration::from_millis(100);
        assert!(matches!(
            send(Request::Configure(pb::Configure {
                protocol_version: PROTOCOL_VERSION,
                limits: Some(pb::ResourceLimits {
                    max_feed_duration_micros: Some(budget.as_micros() as u64),
                    ..Default::default()
                }),
                ..Default::default()
            })),
            Event::Ok(_)
        ));
        let mut next = send(Request::Feed(pb::Feed {
            code: "import tools\ndescribe = describe_tool\ndescribe('ping')\nsearch = search_tools\nsearch('ping')\naction = ping\naction()\n42".into(),
            ..Default::default()
        }));
        let mut waited = vec![];
        let resume = |call_id, value| {
            let (result, values) = ext_result_to_proto(ExtFunctionResult::Return(value));
            Request::ResumeCall(pb::ResumeCall {
                call_id,
                result: Some(result),
                values,
            })
        };
        loop {
            let request = match next {
                Event::OsCall(call) => {
                    waited.push("import".into());
                    resume(
                        call.call_id,
                        MontyObject::module("tools", MontyUuid::from_u128(1), []),
                    )
                }
                Event::NameLookup(lookup) => {
                    waited.push(format!("lookup:{}", lookup.name));
                    Request::ResumeNameLookup(
                        NameLookupResult::Value(MontyObject::function(lookup.name, None)).into(),
                    )
                }
                Event::FunctionCall(call) => {
                    waited.push(call.function_name);
                    resume(call.call_id, MontyObject::none())
                }
                Event::Complete(_) => break,
                other => panic!("unexpected worker event: {other:?}"),
            };
            std::thread::sleep(budget);
            next = send(request);
        }
        assert_eq!(
            waited,
            [
                "import",
                "lookup:describe_tool",
                "describe_tool",
                "lookup:search_tools",
                "search_tools",
                "lookup:ping",
                "ping"
            ]
        );
    }
}
