//! Drive one Monty checkout over stdio. Only the agent handles tool calls.
use super::{CodeTool, MODULE, Run, convert, raise};
use monty_pool::{Checkout, OnRawEvent, Pool, PoolConfig, PoolError, ReplConfig};
use monty_proto::{
    ext_result_to_proto, future_results_to_proto, named_values_to_proto, os_call_from_proto,
    pb::{self, client_request::Kind as Request, worker_event::Kind as Event},
};
use monty_types::{
    DateTimeSource, ExcType, ExtFunctionResult, MontyException, MontyObject, MontyUuid,
    NameLookupResult, OsFunctionCall, OsPolicy, ProcessTime, RandomStart, ResourceLimits,
    SleepMode,
};
#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, OwnedFd};
use std::{
    future::{pending, ready},
    io,
    time::Duration,
};
#[cfg(target_os = "linux")]
use tokio::io::unix::AsyncFd;
use tokio::{sync::Notify, time::timeout};

const MAX_MEMORY: usize = 256 * 1024 * 1024;
const WORKER_STARTUP_LIMIT: Duration = Duration::from_secs(10);
const PIPE_ALLOWANCE: Duration = Duration::from_millis(250);
const TIME_LIMIT: &str = "TimeoutError: sandbox time limit exceeded";

pub(super) enum RunError {
    Failed(String),
    PrintLimit(usize),
}

fn keep_printed(printed: &mut String, text: &str, cap: usize) -> bool {
    let left = cap - printed.len();
    printed.push_str(&text[..text.floor_char_boundary(left)]);
    text.len() <= left
}

pub(super) async fn pool(tool: &CodeTool) -> anyhow::Result<Pool> {
    let executable = match &tool.worker {
        Some(path) => path.clone(),
        None => std::env::current_exe()?,
    };
    let mut config = PoolConfig::subprocess(executable);
    // Spawn only when a run needs a worker, and don't keep a spare process.
    config.min_processes = 0;
    Ok(Pool::new(config).await?)
}

impl Run<'_> {
    pub(super) async fn sandbox(
        &mut self,
        code: &str,
        pool: &Pool,
    ) -> (Result<MontyObject, RunError>, String) {
        let config = ReplConfig {
            limits: Some(
                ResourceLimits::default()
                    .max_memory(MAX_MEMORY)
                    // Monty restarts this limit at each resume. The agent also
                    // checks cumulative active time between nested tool calls.
                    .max_turn_duration(self.tool.compute)
                    .max_recursion_depth(self.tool.recursion)
                    // The agent counts nested calls, not name and catalog lookups.
                    .max_suspensions(usize::MAX),
            ),
            os_policy: OsPolicy {
                datetime: DateTimeSource::CallHost,
                sleep: SleepMode::CallHost,
                process_time: ProcessTime::Zero,
                random_start: RandomStart::CallHost,
                ..OsPolicy::default()
            },
            ..ReplConfig::default()
        };
        let mut worker = match pool.checkout(&config).await {
            Ok(worker) => worker,
            Err(error) => return (Err(RunError::Failed(error.to_string())), String::new()),
        };
        // Never finish this checkout back into the pool. On success, error or
        // cancellation, Drop kills the worker and releases its pool slot. In
        // particular Monty cannot safely reset a heap after a limit fires.
        // Checkout spawns the worker but does not wait for it to be ready.
        // Acknowledge Configure before starting the first execution deadline.
        match timeout(WORKER_STARTUP_LIMIT, worker.open()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return (Err(RunError::Failed(error.to_string())), String::new()),
            Err(_) => {
                return (
                    Err(RunError::Failed("sandbox worker did not start".into())),
                    String::new(),
                );
            }
        }
        let mut printed = String::new();
        let full = Notify::new();
        let cap = self.tool.print_bytes;
        let outcome = {
            let mut print = |event: &pb::WorkerEvent| -> monty_pool::PrintFuture {
                if let Some(Event::Print(batch)) = &event.kind {
                    for segment in batch.segments.iter() {
                        if !keep_printed(&mut printed, &segment.text, cap) {
                            // Stop reading before dispatching a call or using the final value.
                            full.notify_one();
                            return Box::pin(pending());
                        }
                    }
                }
                Box::pin(ready(()))
            };
            tokio::select! {
                biased;
                _ = full.notified() => Err(RunError::PrintLimit(cap)),
                outcome = self.drive(code, &mut worker, &mut print) => outcome.map_err(RunError::Failed),
            }
        };
        (outcome, printed)
    }

    /// Tools sit under a name of their own because some share a name with a
    /// Python builtin, such as `exec` and `list`.
    fn module(&self) -> MontyObject {
        MontyObject::module(
            MODULE,
            MontyUuid::from_u128(1),
            self.functions.values().map(|function| {
                (
                    MontyObject::string(function.name.as_str()),
                    MontyObject::function(
                        format!("{MODULE}.{}", function.name),
                        Some(function.tool.description.clone()),
                    ),
                )
            }),
        )
    }

    async fn drive(
        &mut self,
        code: &str,
        worker: &mut Checkout,
        print: OnRawEvent<'_>,
    ) -> Result<MontyObject, String> {
        let pid = worker.pid().ok_or("sandbox worker exited before running")?;
        let exit =
            watch_exit(pid).map_err(|error| format!("could not watch sandbox worker: {error}"))?;
        let (inputs, values) =
            named_values_to_proto(vec![(MODULE.to_owned(), self.module())].into());
        let mut request = Request::Feed(pb::Feed {
            code: code.to_owned(),
            inputs,
            values: Some(values),
            skip_type_check: true,
            ..Default::default()
        });
        let mut last = Duration::ZERO;
        let mut checkpoint = Duration::ZERO;
        loop {
            // The typed pool API drops the worker's feed clock. Use its raw
            // API for the clock while keeping the pool's framing and lifecycle.
            let remaining = self.tool.compute - (last - checkpoint);
            let event = timeout(
                remaining.saturating_add(PIPE_ALLOWANCE),
                worker.turn_raw(
                    &pb::ClientRequest {
                        kind: Some(request),
                        ..Default::default()
                    },
                    print,
                ),
            )
            .await
            .map_err(|_| TIME_LIMIT.to_owned())?
            .map_err(|error| match error {
                PoolError::Timeout { .. } => TIME_LIMIT.to_owned(),
                _ => error.to_string(),
            })?;

            let event_kind = event.kind.ok_or("sandbox worker returned an empty event")?;
            let exception = if let Event::Error(error) = &event_kind {
                let exc = MontyException::try_from(
                    error
                        .exception
                        .clone()
                        .ok_or("sandbox worker omitted the exception")?,
                )
                .map_err(|err| err.to_string())?;
                // Keep the interpreter's traceback for its own limit errors.
                if matches!(exc.exc_type(), ExcType::TimeoutError | ExcType::MemoryError) {
                    return Err(exception_text(&exc));
                }
                Some(exc)
            } else {
                None
            };
            let active = Duration::from_micros(event.feed_execution_micros);
            if active < last {
                return Err("sandbox worker execution clock went backwards".into());
            }
            last = active;
            if last - checkpoint >= self.tool.compute {
                return Err(TIME_LIMIT.into());
            }
            if let Some(exc) = exception {
                return Err(exception_text(&exc));
            }

            request = match event_kind {
                Event::Complete(value) => {
                    return MontyObject::try_from(value).map_err(|err| err.to_string());
                }
                Event::NameLookup(lookup) => {
                    let found = match (lookup.object_id, lookup.name.as_str()) {
                        (None, name @ ("describe_tool" | "search_tools")) => {
                            NameLookupResult::Value(MontyObject::function(name, None))
                        }
                        _ => NameLookupResult::Undefined,
                    };
                    Request::ResumeNameLookup(found.into())
                }
                Event::FunctionCall(call) => {
                    let name = call.function_name.clone();
                    let (id, eager, receiver) =
                        (call.call_id, call.allow_eager_await, call.object_id);
                    let args = call.into_call_args().map_err(|err| err.to_string())?;
                    let prior = self.calls.made;
                    let result = if receiver.is_some() {
                        Err(raise(
                            ExcType::NameError,
                            format!("name '{name}' is not defined"),
                        ))
                    } else {
                        // While the worker waits for a tool, watch for process exit
                        // without running the pipe watchdog or the compute clock.
                        tokio::select! {
                            biased;
                            exited = worker_exited(&exit) => return Err(match exited {
                                Ok(_) => "sandbox worker died while waiting for a nested tool call".into(),
                                Err(error) => format!("could not watch sandbox worker: {error}"),
                            }),
                            result = self.call(&name, &args) => result,
                        }
                    };
                    if self.calls.made != prior {
                        checkpoint = last;
                    }
                    let result = match result {
                        Ok(value) => ExtFunctionResult::Return(convert::to_python(&value)),
                        Err(error) => ExtFunctionResult::Error(error),
                    };
                    resume(id, eager, result)
                }
                Event::OsCall(call) => {
                    let eager = call.allow_eager_await;
                    let (id, call) = os_call_from_proto(call).map_err(|err| err.to_string())?;
                    let result = match &call {
                        OsFunctionCall::Import(import) if import.module == MODULE => {
                            ExtFunctionResult::Return(self.module())
                        }
                        _ => ExtFunctionResult::Error(raise(
                            ExcType::RuntimeError,
                            "the sandbox has no direct access to files, the network, the clock or the environment; use the provided functions",
                        )),
                    };
                    resume(
                        id,
                        eager && OsFunctionCall::accepts_future(call.name()),
                        result,
                    )
                }
                Event::ResolveFutures(_) => {
                    return Err("RuntimeError: awaited something that never resolves".into());
                }
                Event::FatalError(error) => {
                    return Err(format!("sandbox worker died: {}", error.message));
                }
                Event::SessionRefused(error) => {
                    return Err(format!(
                        "sandbox worker refused configuration: {}",
                        error.message
                    ));
                }
                _ => return Err("sandbox worker returned an unexpected event".into()),
            };
        }
    }
}

fn resume(call_id: u32, eager: bool, result: ExtFunctionResult) -> Request {
    if eager {
        Request::ResumeFutures(future_results_to_proto(vec![(call_id, result)]))
    } else {
        let (result, values) = ext_result_to_proto(result);
        Request::ResumeCall(pb::ResumeCall {
            call_id,
            result: Some(result),
            values,
        })
    }
}

fn exception_text(exc: &MontyException) -> String {
    let mut text = exc.to_string();
    if exc.message() == Some("") {
        text.truncate(text.len() - ": ".len());
    }
    text
}

#[cfg(target_os = "linux")]
async fn worker_exited(exit: &AsyncFd<OwnedFd>) -> io::Result<()> {
    exit.readable().await.map(|_| ())
}

#[cfg(target_os = "macos")]
fn watch_exit(pid: u32) -> io::Result<u32> {
    Ok(pid)
}

#[cfg(target_os = "macos")]
async fn worker_exited(pid: &u32) -> io::Result<()> {
    // `siginfo_t` holds a raw pointer on macOS, so it must not live across an await.
    while !worker_has_exited(*pid)? {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn worker_has_exited(pid: u32) -> io::Result<bool> {
    loop {
        // Observe the owned child without reaping it; Monty's pool does that.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ECHILD) => return Ok(true),
                Some(libc::EINTR) => continue,
                _ => return Err(error),
            }
        }
        return Ok(unsafe { info.si_pid() } != 0);
    }
}

#[cfg(target_os = "linux")]
fn watch_exit(pid: u32) -> io::Result<AsyncFd<OwnedFd>> {
    // SAFETY: pidfd_open takes a PID value and zero flags, and returns a new
    // owned descriptor on success. The pool still owns the child handle.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OwnedFd keeps this pollable descriptor open and exclusive
    // while it is registered with Tokio.
    unsafe { AsyncFd::register(OwnedFd::from_raw_fd(fd as i32)) }.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::keep_printed;

    #[test]
    fn the_print_limit_keeps_the_longest_utf8_prefix() {
        let mut printed = String::new();
        let cap = 1024 * 1024;
        assert!(keep_printed(&mut printed, &"x".repeat(cap - 5), cap));
        assert!(keep_printed(&mut printed, "é", cap));
        assert!(!keep_printed(&mut printed, "😀x", cap));
        assert_eq!(printed.len(), cap - 3);
        assert!(printed.ends_with("xé"));
    }
}
