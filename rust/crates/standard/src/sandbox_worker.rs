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
