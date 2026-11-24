//! Recorded, keyed input requests. Raw secret answers stop at this boundary.
use agent_api::*;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;
#[derive(Default)]
pub struct QuestionsPlugin;
#[derive(Default)]
struct Questions {
    lock: Mutex<()>,
    present: Mutex<std::collections::BTreeMap<(String, String, String), bool>>,
    notify: Notify,
}
impl Plugin for QuestionsPlugin {
    fn name(&self) -> &str {
        "feature.questions"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let service = Arc::new(Questions::default());
        r.provide::<dyn InputRequests>("input.requests", service.clone())?;
        r.provide::<dyn ToolSource>("tools.questions", service)?;
        r.declare(json!({"questions_outlast_turn":true,"input_requests":["approval","choice","text","secret"]}));
        Ok(())
    }
}
fn question_deadline(data: &SessionData, q: &Question) -> Option<u64> {
    let timeout = q.timeout_ms?;
    data.entries
        .iter()
        .find(|e| e.kind == "request.open" && e.content.as_ref().is_some_and(|v| v["id"] == q.id))
        .map(|e| e.at.saturating_add(timeout))
}
fn right(q: &Question) -> &str {
    if q.kind == RequestKind::Approval {
        "approve"
    } else {
        "answer"
    }
}
fn may_answer(api: &dyn AgentApi, q: &Question, session: &str, actor: &str) -> bool {
    q.route.iter().any(|s| s == session)
        && (session == q.scope.session
            || q.responders.iter().any(|a| a == actor)
            || (actor == ACP_HOST_ACTOR && q.responders.as_slice() == ["user"]))
        && api.authority(session, actor).is_ok_and(|a| a.has(right(q)))
        && (session == q.scope.session
            || work_authority(api, &q.scope).is_ok_and(|a| a.has(right(q))))
}
fn route(api: &dyn AgentApi, session: &str) -> Result<Vec<String>> {
    let mut result = vec![session.to_string()];
    let mut data = api.snapshot(session)?;
    while let Some(parent) = data.settings["_parent"]["session"].as_str() {
        ensure!(!result.iter().any(|s| s == parent), "parent cycle");
        result.push(parent.into());
        data = api.snapshot(parent)?;
    }
    Ok(result)
}
impl Questions {
    fn open(&self, api: &dyn AgentApi, mut q: Question) -> Result<Question> {
        let _guard = self.lock.lock().unwrap();
        // Only the writer's pre-dispatch checkpoint can mark a waiting
        // approval. A draft from a running tool is never that checkpoint.
        if let Some(extra) = q.extra.as_object_mut() {
            extra.remove("approvalWait");
            extra.remove("approvalView");
            extra.remove("deadlineAt");
        }
        q.route = route(api, &q.scope.session)?;
        if let Some(key) = &q.key
            && let Some(old) = questions(&api.snapshot(&q.scope.session)?)?
                .into_iter()
                .rev()
                .find(|old| old.key.as_ref() == Some(key))
        {
            ensure!(
                old.kind == q.kind
                    && old.text == q.text
                    && old.options == q.options
                    && old.credential == q.credential
                    && old.extra["details"] == q.extra["details"]
                    && old.extra["whenTimeLimit"] == q.extra["whenTimeLimit"]
                    && (old.extra["kind"] == "link") == (q.extra["kind"] == "link")
                    && old.scope.call == q.scope.call,
                "question key reused for different request"
            );
            if old
                .answer
                .as_ref()
                .is_some_and(|a| may_answer(api, &old, &a.session, &a.actor))
                || old.answerable
            {
                return Ok(old);
            }
            api.append(
                &q.scope,
                "feature.questions",
                Draft::new("request.invalidated", false, json!({"request":old.id})),
            )?;
        }
        api.append(
            &q.scope,
            "feature.questions",
            Draft::new("request.open", false, json!(q)),
        )?;
        Ok(q)
    }
}
#[async_trait]
impl InputRequests for Questions {
    async fn ask(&self, api: Api, q: Question, cancel: CancellationToken) -> Result<RequestReply> {
        if q.kind == RequestKind::Secret
            && (q
                .credential
                .as_ref()
                .is_none_or(|s| s.is_empty() || api.provider_credential(s))
                || !capability::<dyn CredentialStore>(api.as_ref(), "credentials")
                    .is_ok_and(|s| q.credential.as_deref().is_some_and(|name| s.accepts(name))))
        {
            return Ok(RequestReply::Declined);
        }
        let q = self.open(api.as_ref(), q)?;
        let deadline =
            question_deadline(&api.snapshot(&q.scope.session)?, &q).unwrap_or(u64::MAX / 2);
        if let Some(answer) = q.answer.clone() {
            return Ok(RequestReply::Answer(answer));
        }
        if !q.route.iter().any(|session| {
            let joined = api
                .snapshot(session)
                .map(|d| actors(&d))
                .unwrap_or_default();
            q.responders
                .iter()
                .chain(joined.keys())
                .map(String::as_str)
                .chain(std::iter::once(ACP_HOST_ACTOR))
                .any(|actor| may_answer(api.as_ref(), &q, session, actor))
        }) {
            api.append(
                &q.scope,
                "feature.questions",
                Draft::new(
                    "request.closed",
                    false,
                    json!({"request":q.id,"reason":if q.kind == RequestKind::Approval { "refused" } else { "noLongerAnswerable" }}),
                ),
            )?;
            return Ok(RequestReply::Declined);
        }
        if q.kind == RequestKind::Approval {
            let present = self.present.lock().unwrap().clone();
            if !present.iter().any(|((session, actor, _), allowed)| {
                *allowed && may_answer(api.as_ref(), &q, session, actor)
            }) {
                api.append(
                    &q.scope,
                    "feature.questions",
                    Draft::new(
                        "request.closed",
                        false,
                        json!({"request":q.id,"reason":"refused"}),
                    ),
                )?;
                return Ok(RequestReply::Declined);
            }
        }
        api.emit(Event::new(&q.scope, "request.opened", json!(q)))
            .await?;
        let deadline = wait_until(deadline);
        tokio::pin!(deadline);
        loop {
            // Register before inspecting the ledger, so an answer cannot lose a wake.
            // https://docs.rs/tokio/1.54.1/tokio/sync/futures/struct.Notified.html#method.enable
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let current = questions(&api.snapshot(&q.scope.session)?)?
                .into_iter()
                .find(|v| v.id == q.id)
                .ok_or_else(|| anyhow!("question left current branch"))?;
            if let Some(answer) = current.answer {
                return Ok(RequestReply::Answer(answer));
            }
            if !current.answerable {
                return Ok(RequestReply::Declined);
            }
            if q.kind == RequestKind::Approval
                && !self
                    .present
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|((session, actor, _), allowed)| {
                        *allowed && may_answer(api.as_ref(), &q, session, actor)
                    })
            {
                api.append(
                    &q.scope,
                    "feature.questions",
                    Draft::new(
                        "request.closed",
                        false,
                        json!({"request":q.id,"reason":"noLongerAnswerable"}),
                    ),
                )?;
                return Ok(RequestReply::Declined);
            }
            tokio::select! {
                _ = notified => (),
                _ = cancel.cancelled() => {
                    self.close_turn(api.as_ref(), &q.scope)?;
                    return Ok(RequestReply::Declined);
                }
                _ = &mut deadline => {
                    if q.extra["whenTimeLimit"] == "decline" {
                        self.close_if_open(api.as_ref(), &q, "timeLimit")?;
                        return Ok(RequestReply::Declined);
                    }
                    api.append(&q.scope, "feature.questions", Draft::new("request.suspended", false, json!({"request":q.id})))?;
                    return Ok(RequestReply::Waiting);
                }
            }
        }
    }
    async fn answer(
        &self,
        api: Api,
        session: &str,
        actor: &str,
        request: &str,
        value: Value,
        declined: bool,
    ) -> Result<()> {
        self.record_answer(api, session, actor, request, value, declined, None, None)
            .await
    }

    async fn decline(
        &self,
        api: Api,
        session: &str,
        actor: &str,
        request: &str,
        reason: Option<String>,
    ) -> Result<()> {
        self.record_answer(
            api,
            session,
            actor,
            request,
            Value::Null,
            true,
            reason,
            None,
        )
        .await
    }

    fn recover(&self, api: &dyn AgentApi, session: &str) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        let data = api.snapshot(session)?;
        let store = match capability::<dyn CredentialStore>(api, "credentials") {
            Ok(store) => store,
            Err(_) => return Ok(()),
        };
        for q in questions(&data)?
            .into_iter()
            .filter(|q| q.kind == RequestKind::Secret)
        {
            let request = secret_request(&q);
            if !q.answerable {
                if !q.answer.as_ref().is_some_and(|a| !a.declined) {
                    store.discard(&request)?;
                }
            } else if let Some(selected) = selected(&data, &q) {
                self.finish_secret(api, store.as_ref(), &q, selected)?;
            } else if store.lookup_staged(&request)?.is_some() {
                // No decision reached the ledger. Retire this id so a durable
                // replay re-asks with a new id even if the tool uses a key.
                self.close_question(api, &q, "noLongerAnswerable")?;
            }
        }
        Ok(())
    }

    fn visible(&self, api: &dyn AgentApi, session: &str, actor: &str) -> Result<Vec<Question>> {
        require(
            api,
            &Scope {
                actor: actor.into(),
                ..Scope::session(session)
            },
            "watch",
        )?;
        let mut result = vec![];
        for data in api.list(None)? {
            result.extend(
                questions(&data)?
                    .into_iter()
                    .filter(|q| q.route.iter().any(|s| s == session)),
            );
        }
        Ok(result)
    }

    fn eligible(
        &self,
        api: &dyn AgentApi,
        question: &Question,
        session: &str,
        actor: &str,
    ) -> bool {
        may_answer(api, question, session, actor)
    }

    async fn answer_on_route(&self, api: Api, route: &str, a: Answer) -> Result<()> {
        self.record_answer(
            api,
            &a.session,
            &a.actor,
            &a.request,
            a.value,
            a.declined,
            a.reason,
            Some(route),
        )
        .await
    }
    fn connect_answer_route(&self, session: &str, actor: &str, route: &str, approvals: bool) {
        let _guard = self.lock.lock().unwrap();
        self.present
            .lock()
            .unwrap()
            .insert((session.into(), actor.into(), route.into()), approvals);
        self.notify.notify_waiters();
    }
    fn presence(&self, session: &str, actor: &str, present: bool) {
        self.presence_route(session, actor, "", present);
    }
    fn presence_route(&self, session: &str, actor: &str, route: &str, present: bool) {
        let _guard = self.lock.lock().unwrap();
        let key = (session.into(), actor.into(), route.into());
        if present {
            self.present.lock().unwrap().insert(key, true);
        } else {
            self.present.lock().unwrap().remove(&key);
        }
        self.notify.notify_waiters();
    }

    fn detach_presence(&self, session: &str, route: &str) {
        let _guard = self.lock.lock().unwrap();
        self.present
            .lock()
            .unwrap()
            .retain(|(id, _, on), _| id != session || on != route);
        self.notify.notify_waiters();
    }
    fn present(&self, session: &str) -> Vec<String> {
        self.present
            .lock()
            .unwrap()
            .keys()
            .filter(|(s, _, _)| s == session)
            .map(|(_, a, _)| a.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    fn present_for_approval(&self, session: &str) -> Vec<String> {
        self.present
            .lock()
            .unwrap()
            .iter()
            .filter(|((id, _, _), approved)| **approved && id == session)
            .map(|((_, actor, _), _)| actor.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    fn close_turn_with_reason(
        &self,
        api: &dyn AgentApi,
        scope: &Scope,
        reason: &str,
    ) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        let data = api.snapshot(&scope.session)?;
        for q in questions(&data)?.into_iter().filter(|q| {
            q.answerable
                && q.scope.turn == scope.turn
                && (scope.call.is_none() || q.scope.call == scope.call)
        }) {
            if selected(&data, &q).is_none() {
                self.close_question(api, &q, reason)?;
            }
        }
        self.notify.notify_waiters();
        Ok(())
    }
}
impl Questions {
    #[allow(clippy::too_many_arguments)]
    async fn record_answer(
        &self,
        api: Api,
        session: &str,
        actor: &str,
        request: &str,
        value: Value,
        declined: bool,
        reason: Option<String>,
        route: Option<&str>,
    ) -> Result<()> {
        let (q, answer) = {
            let _guard = self.lock.lock().unwrap();
            let mut candidates = Vec::new();
            for data in api.list(None)? {
                candidates.extend(
                    questions(&data)?
                        .into_iter()
                        .filter(|q| q.route.iter().any(|s| s == session)),
                );
            }
            let q = candidates
                .into_iter()
                .find(|q| q.id == request)
                .ok_or_else(|| anyhow!("unknown request"))?;
            ensure!(
                !q.waits_for_approval(),
                "waiting approval needs a delivered view"
            );
            ensure!(q.answerable && q.answer.is_none(), "request is closed");
            ensure!(
                may_answer(api.as_ref(), &q, session, actor),
                "actor may not answer"
            );
            if q.kind == RequestKind::Approval {
                ensure!(
                    self.present
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|((s, a, _), approved)| *approved && s == session && a == actor),
                    "approval answerer is not present"
                );
            }
            // The portable answer for an approval refusal is an actor decline,
            // even when the permission route sends the option as a string.
            let declined = declined || (q.kind == RequestKind::Approval && value == "refuse");
            if let Some(route) = route {
                ensure!(
                    self.present
                        .lock()
                        .unwrap()
                        .get(&(session.into(), actor.into(), route.into()))
                        .is_some_and(|allow| *allow || q.kind != RequestKind::Approval),
                    "answer route is no longer eligible"
                );
            }
            let data = api.snapshot(&q.scope.session)?;
            if q.extra["whenTimeLimit"] == "decline"
                && question_deadline(&data, &q).is_some_and(|deadline| now() >= deadline)
            {
                self.close_question(api.as_ref(), &q, "timeLimit")?;
                self.notify.notify_waiters();
                bail!("question deadline expired");
            }
            if q.kind == RequestKind::Secret && (selected(&data, &q).is_some() || !declined) {
                let store = capability::<dyn CredentialStore>(api.as_ref(), "credentials")?;
                let receipt = StagingReceipt {
                    request: secret_request(&q),
                    name: q
                        .credential
                        .clone()
                        .ok_or_else(|| anyhow!("credential name missing"))?,
                    actor: actor.into(),
                    answer_session: session.into(),
                };
                if let Some(previous) = selected(&data, &q) {
                    ensure!(
                        previous["actorId"] == actor
                            && previous["answerSession"] == session
                            && !declined,
                        "secret decision is already selected"
                    );
                } else {
                    ensure!(
                        store.accepts(&receipt.name) && !api.provider_credential(&receipt.name),
                        "invalid secret target"
                    );
                    if let Some(secret) = value.as_str() {
                        store.stage(receipt.clone(), secret)?;
                    }
                    ensure!(
                        store.lookup_staged(&receipt.request)?.as_ref() == Some(&receipt),
                        "invalid staging receipt"
                    );
                    let scope = Scope {
                        actor: actor.into(),
                        ..q.scope.clone()
                    };
                    api.append(
                        &scope,
                        "feature.questions",
                        Draft::new(
                            "request.secretAccepted",
                            false,
                            json!({"requestId":q.id,"actorId":actor,"answerSession":session}),
                        ),
                    )?;
                }
                let committed = json!({"actorId":actor,"answerSession":session});
                let answer = self.finish_secret(api.as_ref(), store.as_ref(), &q, &committed)?;
                (q, answer)
            } else {
                let value = if declined {
                    Value::Null
                } else {
                    match q.kind {
                        // data.md: an approval's answer is "allow" and a refusal is a
                        // decline, so a draft need not list options. An older draft
                        // that lists "refuse" as an option keeps accepting it.
                        RequestKind::Approval => {
                            ensure!(
                                value.as_str().is_some_and(|s| {
                                    s == "allow" || q.options.iter().any(|o| o == s)
                                }),
                                "approval answer must be allow"
                            );
                            value
                        }
                        RequestKind::Choice => {
                            ensure!(
                                value
                                    .as_str()
                                    .is_some_and(|s| q.options.iter().any(|o| o == s)),
                                "invalid option"
                            );
                            value
                        }
                        RequestKind::Text => {
                            ensure!(value.is_string(), "text answer required");
                            value
                        }
                        RequestKind::Secret => unreachable!("secret values use staging"),
                    }
                };
                let answer = Answer {
                    request: q.id.clone(),
                    actor: actor.into(),
                    session: session.into(),
                    value,
                    declined,
                    reason,
                };
                let mut scope = q.scope.clone();
                scope.actor = actor.into();
                api.append(
                    &scope,
                    "feature.questions",
                    Draft::new("request.answer", false, json!(answer)),
                )?;
                if q.kind == RequestKind::Secret {
                    capability::<dyn CredentialStore>(api.as_ref(), "credentials")?
                        .discard(&secret_request(&q))?;
                }
                (q, Some(answer))
            }
        };
        self.notify.notify_waiters();
        if let Some(answer) = answer {
            api.emit(Event::new(&q.scope, "request.answered", json!(answer)))
                .await?;
        }
        Ok(())
    }

    fn finish_secret(
        &self,
        api: &dyn AgentApi,
        store: &dyn CredentialStore,
        q: &Question,
        selected: &Value,
    ) -> Result<Option<Answer>> {
        let request = secret_request(q);
        let receipt = store
            .lookup_staged(&request)?
            .ok_or_else(|| anyhow!("selected secret receipt unavailable"))?;
        ensure!(
            receipt.request == request
                && Some(receipt.name.as_str()) == q.credential.as_deref()
                && selected["actorId"] == receipt.actor
                && selected["answerSession"] == receipt.answer_session,
            "selected secret receipt does not match the ledger"
        );
        if store.activate(&request)? == Activation::Superseded {
            self.append_closed(api, q, "superseded")?;
            return Ok(None);
        }
        let answer = Answer {
            request: q.id.clone(),
            actor: receipt.actor,
            session: receipt.answer_session,
            value: json!({"credential":receipt.name}),
            declined: false,
            reason: None,
        };
        let scope = Scope {
            actor: answer.actor.clone(),
            ..q.scope.clone()
        };
        api.append(
            &scope,
            "feature.questions",
            Draft::new("request.answer", false, json!(answer)),
        )?;
        Ok(Some(answer))
    }

    fn close_if_open(&self, api: &dyn AgentApi, q: &Question, reason: &str) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        let data = api.snapshot(&q.scope.session)?;
        if selected(&data, q).is_none()
            && questions(&data)?
                .iter()
                .any(|current| current.id == q.id && current.answerable)
        {
            self.close_question(api, q, reason)?;
        }
        Ok(())
    }

    fn append_closed(&self, api: &dyn AgentApi, q: &Question, reason: &str) -> Result<()> {
        api.append(
            &q.scope,
            "feature.questions",
            Draft::new(
                "request.closed",
                false,
                json!({"request":q.id,"reason":reason}),
            ),
        )?;
        Ok(())
    }

    fn close_question(&self, api: &dyn AgentApi, q: &Question, reason: &str) -> Result<()> {
        self.append_closed(api, q, reason)?;
        if q.kind == RequestKind::Secret
            && let Ok(store) = capability::<dyn CredentialStore>(api, "credentials")
        {
            store.discard(&secret_request(q))?;
        }
        Ok(())
    }
}
fn selected<'a>(data: &'a SessionData, q: &Question) -> Option<&'a Value> {
    data.entries
        .iter()
        .filter(|e| e.kind == "request.secretAccepted")
        .filter_map(|e| e.content.as_ref())
        .find(|c| c["requestId"] == q.id)
}
fn secret_request(q: &Question) -> SecretRequest {
    SecretRequest {
        session: q.scope.session.clone(),
        request: q.id.clone(),
    }
}
#[async_trait]
impl ToolSource for Questions {
    fn tools(&self, _: &SessionData) -> Vec<ToolDefinition> {
        vec![ToolDefinition { name:"ask_user".into(), description:"Ask an authorized actor for text, a choice, or a secret kept only as a credential name. A deadline leaves the call open.".into(), input:json!({"type":"object","properties":{"kind":{"type":"string","enum":["text","choice","secret"]},"question":{"type":"string"},"options":{"type":"array","items":{"type":"string"}},"credential":{"type":"string"},"timeout_ms":{"type":"integer"}},"required":["question"]}), read_only:true, safe_to_repeat:true, parallel:false, hints: json!({}), }]
    }
    async fn run(
        &self,
        api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
        let run: Result<ToolResult> = async {
            let kind = match call.input["kind"].as_str().unwrap_or("text") {
                "text" => RequestKind::Text,
                "choice" => RequestKind::Choice,
                "secret" => RequestKind::Secret,
                _ => bail!("invalid question kind"),
            };
            let mut q = Question::new(
                scope,
                kind,
                call.input["question"]
                    .as_str()
                    .ok_or_else(|| anyhow!("question required"))?,
            );
            q.options = call
                .input
                .get("options")
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()?
                .unwrap_or_default();
            ensure!(
                q.kind != RequestKind::Choice || !q.options.is_empty(),
                "choice options required"
            );
            q.credential = call.input["credential"].as_str().map(str::to_string);
            q.key = Some(format!("call:{}:1", call.id));
            q.timeout_ms = call.input["timeout_ms"].as_u64();
            Ok(match self.ask(api, q, cancel.clone()).await? {
                RequestReply::Waiting => {
                    ToolResult::new(&call, ToolStatus::Waiting, "waiting for answer")
                }
                RequestReply::Declined => ToolResult::new(
                    &call,
                    if cancel.is_cancelled() {
                        ToolStatus::Cancelled
                    } else {
                        ToolStatus::Refused
                    },
                    "question declined",
                ),
                RequestReply::Answer(a) => ToolResult::new(
                    &call,
                    if a.declined {
                        ToolStatus::Refused
                    } else {
                        ToolStatus::Completed
                    },
                    a.value.to_string(),
                ),
            })
        }
        .await;
        run.unwrap_or_else(|e| ToolResult::new(&call, ToolStatus::Failed, e.to_string()))
    }
}
