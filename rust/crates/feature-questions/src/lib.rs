//! Recorded, keyed input requests. Raw secret answers stop at this boundary.
use agent_api::*;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
#[derive(Default)]
pub struct QuestionsPlugin;
#[derive(Default)]
struct Questions {
    lock: Mutex<()>,
    present: Mutex<BTreeSet<(String, String)>>,
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
            && (q.credential.as_ref().is_none_or(|s| s.is_empty())
                || !capability::<dyn CredentialStore>(api.as_ref(), "credentials")
                    .is_ok_and(|s| q.credential.as_deref().is_some_and(|name| s.accepts(name))))
        {
            return Ok(RequestReply::Declined);
        }
        let timeout = q.timeout_ms;
        let q = self.open(api.as_ref(), q)?;
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
            if !present
                .iter()
                .any(|(session, actor)| may_answer(api.as_ref(), &q, session, actor))
            {
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
        let deadline = tokio::time::sleep(Duration::from_millis(timeout.unwrap_or(u64::MAX / 2)));
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
                    .any(|(session, actor)| may_answer(api.as_ref(), &q, session, actor))
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
                        api.append(&q.scope, "feature.questions", Draft::new("request.closed", false, json!({"request":q.id,"reason":"timeLimit"})))?;
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
            ensure!(q.answerable && q.answer.is_none(), "request is closed");
            ensure!(
                may_answer(api.as_ref(), &q, session, actor),
                "actor may not answer"
            );
            // The portable answer for an approval refusal is an actor decline,
            // even when the permission route sends the option as a string.
            let declined = declined || (q.kind == RequestKind::Approval && value == "refuse");
            let value = if declined {
                Value::Null
            } else {
                match q.kind {
                    RequestKind::Approval | RequestKind::Choice => {
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
                    RequestKind::Secret => {
                        let name = q
                            .credential
                            .as_ref()
                            .ok_or_else(|| anyhow!("credential name missing"))?;
                        capability::<dyn CredentialStore>(api.as_ref(), "credentials")?.put(
                            name,
                            value
                                .as_str()
                                .ok_or_else(|| anyhow!("secret answer required"))?,
                        )?;
                        json!({"credential":name})
                    }
                }
            };
            let answer = Answer {
                request: q.id.clone(),
                actor: actor.into(),
                session: session.into(),
                value,
                declined,
            };
            let mut scope = q.scope.clone();
            scope.actor = actor.into();
            api.append(
                &scope,
                "feature.questions",
                Draft::new("request.answer", false, json!(answer)),
            )?;
            (q, answer)
        };
        self.notify.notify_waiters();
        api.emit(Event::new(&q.scope, "request.answered", json!(answer)))
            .await?;
        Ok(())
    }
    fn visible(&self, api: &dyn AgentApi, session: &str, actor: &str) -> Result<Vec<Question>> {
        ensure!(
            api.authority(session, actor)?.has("watch"),
            "actor may not watch"
        );
        let mut result = vec![];
        for data in api.list(None)? {
            for q in questions(&data)? {
                if q.route.iter().any(|s| s == session) {
                    result.push(q);
                }
            }
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
    fn presence(&self, session: &str, actor: &str, present: bool) {
        let key = (session.into(), actor.into());
        if present {
            self.present.lock().unwrap().insert(key);
        } else {
            self.present.lock().unwrap().remove(&key);
        }
        self.notify.notify_waiters();
    }
    fn present(&self, session: &str) -> Vec<String> {
        self.present
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| id == session)
            .map(|(_, actor)| actor.clone())
            .collect()
    }
    fn close_turn_with_reason(
        &self,
        api: &dyn AgentApi,
        scope: &Scope,
        reason: &str,
    ) -> Result<()> {
        for q in questions(&api.snapshot(&scope.session)?)?
            .into_iter()
            .filter(|q| q.answerable && q.scope.turn == scope.turn)
        {
            api.append(
                &q.scope,
                "feature.questions",
                Draft::new(
                    "request.closed",
                    false,
                    json!({"request":q.id,"reason":reason}),
                ),
            )?;
        }
        self.notify.notify_waiters();
        Ok(())
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
