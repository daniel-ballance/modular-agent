use super::*;

impl OpenAi {
    pub(super) async fn reconcile_erasure(
        &self,
        api: Api,
        session: &str,
        inventory: &mut Inventory,
    ) -> Result<()> {
        let erasures = api
            .snapshot(session)?
            .entries
            .into_iter()
            .filter(|e| e.content.is_none())
            .map(|e| e.id)
            .collect();
        // This comparison also closes the crash window between the history-store
        // erasure commit and the Provider's separate deletion-intent commit.
        if inventory.purge_pending || inventory.erasures != erasures {
            self.state.invalidate(session);
            inventory.purge_pending = true;
            self.state.save(session, inventory)?;
            self.purge(api, session, inventory).await?;
            inventory.erasures = erasures;
            self.state.save(session, inventory)?;
        }
        Ok(())
    }
    // DELETE is per response, not per chain. Keep every known ID until deletion
    // is acknowledged. Source: https://developers.openai.com/api/reference/resources/responses/methods/delete
    pub(super) async fn purge(
        &self,
        api: Api,
        session: &str,
        inventory: &mut Inventory,
    ) -> Result<()> {
        if !inventory.responses.is_empty() {
            let credentials: Arc<dyn CredentialStore> = capability(api.as_ref(), "credentials")?;
            let key = credentials.provider(&self.claim, "openai")?;
            for response in inventory.responses.clone() {
                safe_id(&response)?;
                let result = self
                    .client
                    .delete(format!("{}/{response}", self.endpoint))
                    .bearer_auth(&key)
                    .send()
                    .await?;
                let status = result.status();
                if status.as_u16() != 404 {
                    ensure!(
                        status.is_success(),
                        "OpenAI response deletion failed ({status}); local erasure is committed, retry erasure"
                    );
                    let value: Value = result.json().await?;
                    ensure!(
                        value["deleted"] == true,
                        "OpenAI did not acknowledge response deletion; retry erasure"
                    );
                }
                inventory.responses.remove(&response);
                self.state.save(session, inventory)?;
            }
        }
        inventory.purge_pending = false;
        self.state.save(session, inventory)
    }
    fn remember(
        &self,
        session: &str,
        marker: &str,
        inventory: &mut Inventory,
        response: &Value,
    ) -> Result<()> {
        if self.mode == Mode::Stateful {
            let response = response["id"]
                .as_str()
                .ok_or_else(|| anyhow!("stored OpenAI response lacks ID"))?;
            safe_id(response)?;
            inventory.responses.insert(response.into());
            inventory.uncertain.remove(marker);
            self.state.save(session, inventory)?;
        }
        Ok(())
    }
    async fn read_stream(
        &self,
        api: Api,
        scope: &Scope,
        response: reqwest::Response,
        cancel: &CancellationToken,
        stream_id: &str,
        tracked: (&str, &mut Inventory),
    ) -> Result<Value> {
        let (marker, inventory) = tracked;
        let mut stream = response.bytes_stream();
        let mut buffer = vec![];
        let mut data = String::new();
        let mut completed = None;
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(ModelFailure {kind: FailureKind::Cancelled, message: "cancelled".into()}.into()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            buffer.extend_from_slice(&chunk?);
            ensure!(buffer.len() < 16 * 1024 * 1024, "OpenAI event too large");
            while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = buffer.drain(..=end).collect();
                let line = std::str::from_utf8(&line)?.trim_end_matches(['\r', '\n']);
                if let Some(piece) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(piece.trim_start());
                    ensure!(data.len() < 16 * 1024 * 1024, "OpenAI event too large");
                }
                if line.is_empty() && !data.is_empty() {
                    if data == "[DONE]" {
                        data.clear();
                        continue;
                    }
                    let event: Value = serde_json::from_str(&data)?;
                    data.clear();
                    // Inventory first, before any plugin can fail while observing the event.
                    if matches!(
                        event["type"].as_str(),
                        Some(
                            "response.created"
                                | "response.completed"
                                | "response.incomplete"
                                | "response.failed"
                        )
                    ) {
                        self.remember(&scope.session, marker, inventory, &event["response"])?;
                    }
                    api.invoke(&self.piece, scope, event.clone()).await?;
                    match event["type"].as_str().unwrap_or("") {
                        "response.output_text.delta" => {
                            let mut e = Event::new(scope, "model.delta", event["delta"].clone());
                            e.stream = Some(stream_id.into());
                            api.emit(e).await?;
                        }
                        "response.completed" | "response.incomplete" => {
                            completed = Some(event["response"].clone())
                        }
                        "response.failed" => {
                            return Err(failure(&event["response"]["error"]).into());
                        }
                        "error" => return Err(failure(&event).into()),
                        _ => (),
                    }
                }
            }
        }
        completed.ok_or_else(|| anyhow!("OpenAI stream ended before a complete response"))
    }
    async fn request(
        &self,
        api: Api,
        scope: &Scope,
        request: &ModelRequest,
        cancel: &CancellationToken,
        stream_id: &str,
        key: &str,
    ) -> Result<(ModelResponse, Option<Chain>, u64)> {
        ensure!(
            request.session == scope.session,
            "model request session mismatch"
        );
        let mut body = request_body(request)?;
        body["store"] = json!(self.mode == Mode::Stateful);
        let mut body = api.invoke(&self.before, scope, body).await?.value;
        ensure!(
            body["model"] == "gpt-6-luna" && body["store"] == (self.mode == Mode::Stateful),
            "Provider middleware cannot change allowed model or storage mode"
        );
        ensure!(
            body.get("previous_response_id").is_none() && body.get("conversation").is_none(),
            "Provider middleware cannot supply conversation state"
        );
        // No vendor-managed tools, compaction, truncation or background work may
        // silently add state outside the full context the agent supplies.
        ensure!(
            body["stream"] == true && body.get("background").is_none_or(|v| v == false),
            "unsupported Provider transport mode"
        );
        ensure!(
            body.get("context_management").is_none()
                && body.get("prompt").is_none()
                && body.get("truncation").is_none_or(|v| v == "disabled"),
            "Provider middleware cannot manage context"
        );
        ensure!(
            body["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().all(|t| t["type"] == "function")),
            "Provider tools are not supported"
        );
        let full = body["input"]
            .as_array()
            .ok_or_else(|| anyhow!("OpenAI input must be an array"))?
            .clone();
        let instructions = body["instructions"].clone();
        let mut inventory = self.state.load(&scope.session)?;
        self.reconcile_erasure(api.clone(), &scope.session, &mut inventory)
            .await?;
        let (revision, prior) = self.state.take(&scope.session);
        if self.mode == Mode::Stateful
            && let Some(prior) = prior
            && prior.instructions == instructions
            && full.starts_with(&prior.input)
        {
            body["input"] = json!(&full[prior.input.len()..]);
            body["previous_response_id"] = json!(prior.response);
        }
        loop {
            if cancel.is_cancelled() {
                return Err(ModelFailure {
                    kind: FailureKind::Cancelled,
                    message: "cancelled".into(),
                }
                .into());
            }
            let marker = id();
            if self.mode == Mode::Stateful {
                inventory.uncertain.insert(marker.clone());
                self.state.save(&scope.session, &inventory)?;
            }
            api.emit(Event::new(scope, "provider.openai.request", json!({"continued":body.get("previous_response_id").is_some(),"input_items":body["input"].as_array().unwrap().len(),"full_items":full.len()}))).await?;
            let response = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(ModelFailure {kind: FailureKind::Cancelled, message: "cancelled".into()}.into()),
                response = self.client.post(&self.endpoint).bearer_auth(key).json(&body).send() => response?,
            };
            if !response.status().is_success() {
                let status = response.status();
                let bytes = tokio::select! {
                    _ = cancel.cancelled() => return Err(ModelFailure {kind: FailureKind::Cancelled, message: "cancelled".into()}.into()),
                    bytes = response.bytes() => bytes?,
                };
                let payload: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                if self.mode == Mode::Stateful && status.is_client_error() && status.as_u16() != 408
                {
                    // A 5xx or timeout can follow a remote commit. Without an ID,
                    // its state is unreachable, even though no continuation is used.
                    inventory.uncertain.remove(&marker);
                    self.state.save(&scope.session, &inventory)?;
                }
                // Only a definite rejection of the previous ID permits a full-context retry.
                if body.get("previous_response_id").is_some()
                    && matches!(status.as_u16(), 400 | 404)
                    && (payload["error"]["param"] == "previous_response_id"
                        || payload["error"]["code"] == "previous_response_not_found")
                {
                    body.as_object_mut().unwrap().remove("previous_response_id");
                    body["input"] = json!(full);
                    continue;
                }
                let mut error = failure(&payload["error"]);
                if status.as_u16() == 401 {
                    error.kind = FailureKind::Credentials;
                }
                if status.is_server_error() || status.as_u16() == 429 {
                    error.kind = FailureKind::Temporary;
                }
                return Err(error.into());
            }
            let raw = self
                .read_stream(
                    api.clone(),
                    scope,
                    response,
                    cancel,
                    stream_id,
                    (&marker, &mut inventory),
                )
                .await?;
            let response = normalize_for(request, &raw)?;
            let chain = if self.mode == Mode::Stateful {
                let mut input = full;
                input.extend(raw["output"].as_array().unwrap().iter().cloned());
                Some(Chain {
                    response: raw["id"].as_str().unwrap().into(),
                    input,
                    instructions,
                })
            } else {
                None
            };
            return Ok((response, chain, revision));
        }
    }
}
#[async_trait]
impl ModelAccess for OpenAi {
    fn inference_kind(&self) -> agent_api::telemetry::SpanKind {
        agent_api::telemetry::SpanKind::Client
    }
    fn streaming(&self) -> bool {
        true
    }

    fn info(&self) -> ModelInfo {
        info(self.mode)
    }
    async fn discard(&self, session: &str) -> Result<()> {
        self.state.invalidate(session);
        Ok(())
    }
    async fn generate(
        &self,
        api: Api,
        scope: Scope,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> std::result::Result<ModelResponse, ModelFailure> {
        let stream_id = id();
        // Bindings share this gate and cache, including auxiliary compaction access.
        let result: Result<ModelResponse> = async {
            let _gate = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(ModelFailure {kind: FailureKind::Cancelled, message: "cancelled".into()}.into()),
                gate = self.state.gate.lock() => gate,
            };
            let credentials: Arc<dyn CredentialStore> = capability(api.as_ref(), "credentials")?;
            let key = credentials.provider(&self.claim, "openai")?;
            let result = self.request(api.clone(), &scope, &request, &cancel, &stream_id, &key).await;
            let mut end = Event::new(&scope, "model.end", Value::Null);
            end.stream = Some(stream_id); end.end = true;
            let emitted = api.emit(end).await;
            match result {
                Ok((response, chain, revision)) => {
                    emitted?;
                    if let Some(chain) = chain { self.state.keep(scope.session.clone(), revision, chain); }
                    Ok(response)
                }
                Err(error) => {
                    self.state.invalidate(&scope.session);
                    let mut failure = error.downcast_ref::<ModelFailure>().cloned().unwrap_or(ModelFailure {kind: FailureKind::Other, message: error.to_string()});
                    failure.message = failure.message.replace(&key, "[REDACTED]");
                    Err(failure.into())
                }
            }
        }.await;
        result.map_err(|e| {
            e.downcast_ref::<ModelFailure>()
                .cloned()
                .unwrap_or(ModelFailure {
                    kind: FailureKind::Other,
                    message: e.to_string(),
                })
        })
    }
}
