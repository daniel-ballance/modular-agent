//! Drive one Monty checkout over stdio. Only the agent handles tool calls.
use super::{CodeTool, MODULE, Run, convert, raise};
use monty_pool::{
    Checkout, OnPrint, Pool, PoolConfig, PoolError, ReplConfig, ResumeValue, TurnEvent,
};
use monty_types::{
    DateTimeSource, ExcType, IMPORT_CALL, ImportArgs, MontyObject, MontyUuid, NameLookupResult,
    OsPolicy, PrintStream, ResourceLimits, SleepMode,
};
use std::{
    future::{pending, ready},
    io,
    os::fd::{FromRawFd, OwnedFd},
};
use tokio::{io::unix::AsyncFd, sync::Notify};

const MAX_MEMORY: usize = 256 * 1024 * 1024;

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
    ) -> (Result<MontyObject, String>, String) {
        let config = ReplConfig {
            limits: Some(
                ResourceLimits::default()
                    .max_memory(MAX_MEMORY)
                    .max_turn_duration(self.tool.compute)
                    .max_recursion_depth(self.tool.recursion)
                    // The agent counts nested calls, not name and catalog lookups.
                    .max_suspensions(usize::MAX),
            ),
            os_policy: OsPolicy {
                datetime: DateTimeSource::CallHost,
                sleep: SleepMode::CallHost,
                ..OsPolicy::default()
            },
            ..ReplConfig::default()
        };
        let mut worker = match pool.checkout(&config).await {
            Ok(worker) => worker,
            Err(error) => return (Err(error.to_string()), String::new()),
        };
        // Never finish this checkout back into the pool. On success, error or
        // cancellation, Drop kills the worker and releases its pool slot. In
        // particular Monty cannot safely reset a heap after a limit fires.
        let mut printed = String::new();
        let full = Notify::new();
        let cap = self.tool.print_bytes;
        let outcome = {
            let mut print = |_stream: PrintStream, text: &str| -> monty_pool::PrintFuture {
                let left = cap - printed.len();
                if text.len() <= left {
                    printed.push_str(text);
                    Box::pin(ready(()))
                } else {
                    printed.push_str(&text[..text.floor_char_boundary(left)]);
                    // Stop reading this turn before it can dispatch another
                    // nested call. The sandbox has exceeded its print budget.
                    full.notify_one();
                    Box::pin(pending())
                }
            };
            tokio::select! {
                biased;
                _ = full.notified() => Err(format!("RuntimeError: printed output exceeds the {cap}-byte limit")),
                outcome = self.drive(code, &mut worker, &mut print) => outcome,
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
                        function.name.as_str(),
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
        print: OnPrint<'_>,
    ) -> Result<MontyObject, String> {
        let pid = worker.pid().ok_or("sandbox worker exited before running")?;
        let exit =
            watch_exit(pid).map_err(|error| format!("could not watch sandbox worker: {error}"))?;
        let mut next = worker.feed(code, vec![], vec![], false, print).await;
        loop {
            next = match next.map_err(|error| match error {
                // The pool's wall deadline caught a worker that didn't reach
                // an interpreter checkpoint in time.
                PoolError::Timeout { .. } => {
                    format!("TimeoutError: sandbox time limit exceeded ({error})")
                }
                _ => error.to_string(),
            })? {
                TurnEvent::Complete(value) => return Ok(value),
                TurnEvent::NameLookup { name, .. } => {
                    let found = match name.as_str() {
                        name @ ("describe_tool" | "search_tools") => {
                            NameLookupResult::Value(MontyObject::function(name, None))
                        }
                        MODULE => NameLookupResult::Value(self.module()),
                        _ => NameLookupResult::Undefined,
                    };
                    worker.resume_name_lookup(found, print).await
                }
                TurnEvent::FunctionCall {
                    function_name,
                    args,
                    call_id,
                    allow_eager_await,
                    ..
                } => {
                    // The pool watches the pipes while the VM runs. While it
                    // waits on a nested call, also watch for process exit.
                    let result = tokio::select! {
                        biased;
                        exited = exit.readable() => return Err(match exited {
                            Ok(_) => "sandbox worker died while waiting for a nested tool call".into(),
                            Err(error) => format!("could not watch sandbox worker: {error}"),
                        }),
                        result = self.call(&function_name, &args) => result,
                    };
                    let result = match result {
                        Ok(value) => ResumeValue::Return(convert::to_python(&value)),
                        Err(error) => ResumeValue::Error(error),
                    };
                    if allow_eager_await {
                        worker.resume_futures(vec![(call_id, result)], print).await
                    } else {
                        worker.resume(result, print).await
                    }
                }
                TurnEvent::OsCall {
                    function_name,
                    args,
                    ..
                } => {
                    // `import tools` gives the same object the bare name does.
                    let result = if function_name == IMPORT_CALL
                        && ImportArgs::from_call_args(&args)
                            .is_some_and(|import| import.module == MODULE)
                    {
                        ResumeValue::Return(self.module())
                    } else {
                        ResumeValue::Error(raise(
                            ExcType::RuntimeError,
                            "the sandbox has no direct access to files, the network, the clock or the environment; use the provided functions",
                        ))
                    };
                    worker.resume(result, print).await
                }
                TurnEvent::ResolveFutures { .. } => {
                    // Host functions answer at the call; none can be pending.
                    return Err("RuntimeError: awaited something that never resolves".into());
                }
            };
        }
    }
}

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
