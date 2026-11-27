use super::*;

#[async_trait]
impl Endpoint for Callbacks {
    fn delivery(&self, peer: &Peer, method: &str, params: &Value) -> Option<Gate> {
        let (api, scope, _) = self.capture_scope(peer, params).ok()?;
        (!scope.session.is_empty()).then(|| crate::rpc::scoped(&api, &scope, method))
    }

    async fn request(
        &self,
        peer: Arc<Peer>,
        id: Value,
        method: &str,
        p: Value,
        cancel: CancellationToken,
    ) -> Reply {
        let request = self.serve_request(peer, id, method, p, cancel.clone());
        tokio::pin!(request);
        let cancelled = || Fault::new("cancelled", "host request cancelled");
        let reply = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                match method {
                    // Let cooperative work settle and committed records finish publishing,
                    // but leave room in the caller's five-second cancellation wait.
                    "host/ask" | "host/env/exec" | "host/tools/call" | "host/runtime/model"
                    | "host/runtime/runToolCall" | "host/runtime/record" => {
                        tokio::time::timeout(Duration::from_secs(4), &mut request)
                            .await
                            .map_err(|_| cancelled())?
                    }
                    _ => return Err(cancelled()),
                }
            }
            result = &mut request => result,
        };
        reply.map_err(|e| {
            if cancel.is_cancelled() {
                cancelled()
            } else {
                e
            }
        })
    }
    fn request_barrier(&self, method: &str, params: &Value) -> Option<NotificationKey> {
        match method {
            "host/jobs/end" | "host/jobs/resume" => job_progress_key(params),
            "host/hook" if params["hook"] == "provider.response" => Some(NotificationKey::Stream(
                params.get("parentRequestId")?.to_string(),
            )),
            _ => None,
        }
    }

    fn admit_notification(
        self: Arc<Self>,
        peer: &Arc<Peer>,
        method: &str,
        p: Value,
    ) -> Option<Notification> {
        if method == "tools/changed" {
            // Invalidate at receipt and let the triggering caller refresh after
            // its reply. Never ask tools/list from the reader.
            let source = p["toolSource"].as_str()?;
            let parent = peer.parent(&p["parentRequestId"]);
            if !p["parentRequestId"].is_null()
                && parent.as_ref().is_none_or(|w| w.method == "tools/list")
            {
                return None;
            }
            let view = self
                .0
                .sources
                .lock()
                .unwrap()
                .iter()
                .filter_map(Weak::upgrade)
                .find(|s| s.id == source)?;
            view.invalidate(
                parent
                    .as_ref()
                    .map(|w| w.scope.session.as_str())
                    .filter(|s| !s.is_empty()),
            );
            if let Some(work) = parent {
                work.changed_tools.lock().unwrap().insert(source.into());
            }
            return None;
        }
        if method == "host/jobs/progress" {
            let jobs = crate::jobs::RemoteJobs {
                peer: peer.clone(),
                shared: self.0.clone(),
            };
            return Some(Notification {
                barrier: Some(job_progress_key(&p)?),
                run: Box::pin(async move {
                    let _ = jobs.progress(&p).await;
                }),
            });
        }
        if method == "host/problem" {
            return Some(Notification {
                barrier: None,
                run: Box::pin(async move {
                    eprintln!("plugin problem at {}: {}", p["where"], p["message"]);
                }),
            });
        }
        if method == "host/emit" && peer.handling_output() {
            return None;
        }
        let (api, scope, work) = self.capture_scope(peer, &p).ok()?;
        let barrier = || Some(NotificationKey::Stream(p["parentRequestId"].to_string()));
        if method == "host/runtime/report" {
            let work = work.as_ref()?.clone();
            let runtime = work.runtime.clone()?;
            return Some(Notification {
                barrier: barrier(),
                run: Box::pin(async move {
                    let _ = runtime.report(&api, &work, &p).await;
                }),
            });
        }
        let mut emitter = None;
        let mut event = match method {
            "provider/event"
                if work.as_ref().is_some_and(|work| {
                    work.provider.as_ref().is_some_and(|p| {
                        p.phase.load(Ordering::Acquire) == 2 && p.response.lock().unwrap().is_none()
                    }) && !work.cancel.is_cancelled()
                }) =>
            {
                Event::new(
                    &scope,
                    if p["event"]["type"] == "reasoning" {
                        "model.thought"
                    } else if p["event"]["type"] == "toolInput" {
                        "model.tool_input"
                    } else {
                        "model.delta"
                    },
                    p["event"]["delta"].clone(),
                )
            }
            "tools/progress" if work.as_ref()?.method == "tools/call" => {
                Event::new(&scope, "tool.progress", p["content"].clone())
            }
            "env/output" if work.as_ref()?.method == "env/exec" => {
                Event::new(&scope, "tool.progress", p["chunk"].clone())
            }
            "host/emit" if !work.as_ref().is_some_and(|w| w.cancel.is_cancelled()) => {
                let kind = p["type"].as_str().filter(|kind| kind.contains('.'))?;
                let registration = self.0.registration.lock().unwrap();
                let plugin = registration["name"].as_str()?;
                emitter = Some(plugin.to_owned());
                Event::new(
                    &scope,
                    &format!("plugin.{plugin}.{kind}"),
                    p["data"].clone(),
                )
            }
            _ => return None,
        };
        let barrier = if method == "host/emit" {
            None
        } else {
            event.stream = Some(work?.stream.clone());
            barrier()
        };
        Some(Notification {
            barrier,
            run: Box::pin(async move {
                if api.snapshot(&scope.session).is_ok() {
                    if let Some(name) = emitter {
                        let _ = EMITTER.scope(name, api.emit(event)).await;
                    } else {
                        let _ = api.emit(event).await;
                    }
                }
            }),
        })
    }
}

fn job_progress_key(p: &Value) -> Option<NotificationKey> {
    Some(NotificationKey::Job(p["jobId"].as_str()?.to_owned()))
}
