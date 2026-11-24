//! Sessions, prompts and their results (docs/sdk/api.md#sessions-and-turns).
use crate::{
    agent::Inner,
    error::{Code, Error, Result},
    events::{Event, LOCAL},
    tool::ToolStatus,
};
use agent_api as base;
use base::AgentApi;
use futures_util::Stream;
use serde_json::{Value, json};
use std::sync::Arc;

/// A stream of events. Use it with `StreamExt::next`.
pub type EventStream = std::pin::Pin<Box<dyn Stream<Item = Result<Event>> + Send>>;

/// Shared Content. Unknown parts are retained when stored or relayed.
pub type Content = Vec<Value>;

#[derive(Clone, Debug)]
pub enum PromptInput {
    Text(String),
    Content(Content),
}
impl From<String> for PromptInput {
    fn from(input: String) -> Self {
        Self::Text(input)
    }
}
impl From<&str> for PromptInput {
    fn from(input: &str) -> Self {
        Self::Text(input.into())
    }
}
impl From<&String> for PromptInput {
    fn from(input: &String) -> Self {
        Self::Text(input.clone())
    }
}
impl From<Content> for PromptInput {
    fn from(input: Content) -> Self {
        Self::Content(input)
    }
}
impl PromptInput {
    pub(crate) fn content(self) -> Value {
        match self {
            Self::Text(text) => base::wire::text_content(&text),
            Self::Content(parts) => Value::Array(parts),
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub input_id: String,
    pub actor_id: String,
    pub content: Content,
    pub time: u64,
}

/// A conversation with its history, settings and actors.
#[derive(Clone)]
pub struct Session {
    inner: Arc<Inner>,
    id: String,
    driver: Arc<Driver>,
    approval_route: String,
    actor: String,
}

/// Membership and a grant for an embedded actor.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Actor {
    pub id: String,
    pub kind: String,
    pub rights: Rights,
}

pub use base::Authority as Rights;

#[derive(Default)]
pub(crate) struct Driver {
    run: tokio::sync::Mutex<()>,
    scheduled: std::sync::atomic::AtomicUsize,
}

struct Scheduled(Arc<Driver>);
impl Drop for Scheduled {
    fn drop(&mut self) {
        self.0
            .scheduled
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Timing {
    Now,
    Steer,
    After,
    Propose,
}

impl From<Timing> for base::Timing {
    fn from(timing: Timing) -> Self {
        match timing {
            Timing::Now => Self::Now,
            Timing::Steer => Self::Steer,
            Timing::After => Self::After,
            Timing::Propose => Self::Propose,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ReleaseOptions {
    pub declined: bool,
}

impl From<Option<ReleaseOptions>> for ReleaseOptions {
    fn from(options: Option<ReleaseOptions>) -> Self {
        options.unwrap_or_default()
    }
}

impl From<bool> for ReleaseOptions {
    fn from(declined: bool) -> Self {
        Self { declined }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputReceipt {
    pub input_id: String,
    pub duplicate: bool,
    pub erased: bool,
    pub taken: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandedBack {
    pub input_id: String,
    pub content: Value,
}

/// How a turn ended.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Completed,
    Cancelled,
    Failed { error: String },
    Limit { limit: String },
}

impl Outcome {
    /// The shared kind: `completed`, `cancelled`, `failed` or `limit`.
    pub fn kind(&self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Cancelled => "cancelled",
            Outcome::Failed { .. } => "failed",
            Outcome::Limit { .. } => "limit",
        }
    }
}

/// Whether the input started a turn, or was settled without one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Disposition {
    Turn,
    Handled,
    HandedBack,
}

/// A tool call's recorded result.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub status: ToolStatus,
    pub value: Option<Value>,
    /// Shared Content parts, including any non-text parts.
    pub content: Vec<Value>,
    #[serde(skip)]
    text: String,
}

impl ToolResult {
    pub(crate) fn from_base(name: String, result: base::ToolResult) -> Self {
        let wire = base::wire::result(&result);
        Self {
            call_id: result.call,
            name,
            status: ToolStatus::from_base(&result.status),
            text: result.text,
            value: wire.get("value").cloned(),
            content: wire["content"].as_array().cloned().unwrap_or_default(),
        }
    }

    /// The result's text content.
    pub fn text(&self) -> &str {
        &self.text
    }
}

/// Options for moving the current position.
#[derive(Clone, Debug, Default)]
pub struct MoveOptions {
    pub rewind: bool,
}

/// Options for admitting a prompt.
#[derive(Clone, Debug, Default)]
pub struct PromptOptions {
    pub key: Option<String>,
    pub result: Option<Value>,
}
impl From<Option<String>> for PromptOptions {
    fn from(key: Option<String>) -> Self {
        Self { key, result: None }
    }
}

/// What `prompt` returns.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResult {
    pub input_id: String,
    pub disposition: Disposition,
    /// Present when `disposition` is `Turn`.
    pub outcome: Option<Outcome>,
    /// The final answer's text, empty if none.
    pub text: String,
    pub value: Option<Value>,
    pub turn_id: Option<String>,
    pub open_tool_calls: Vec<String>,
    pub usage: Option<crate::Usage>,
    tool_results: Vec<ToolResult>,
}

impl PromptResult {
    /// The turn's recorded results, in call order.
    pub fn tool_results(&self) -> &[ToolResult] {
        &self.tool_results
    }
}

impl Session {
    pub(crate) fn new(inner: Arc<Inner>, id: String) -> Self {
        let driver = {
            let mut drivers = inner.drivers.lock().unwrap();
            drivers.retain(|_, driver| driver.strong_count() != 0);
            drivers
                .get(&id)
                .and_then(std::sync::Weak::upgrade)
                .unwrap_or_else(|| {
                    let driver = Arc::new(Driver::default());
                    drivers.insert(id.clone(), Arc::downgrade(&driver));
                    driver
                })
        };
        Session {
            inner,
            id,
            driver,
            approval_route: base::id(),
            actor: LOCAL.into(),
        }
    }

    /// Connect an authenticated Interface executor to this session. The app
    /// must check the actual actor's project and tenant scope before calling.
    /// This method never uses a represented actor or a report's claimed identity.
    pub fn connect_interface_tools(
        &self,
        route_id: &str,
        authenticated_actor_id: &str,
        rights: Rights,
    ) -> Result<crate::InterfaceConnection> {
        Ok(crate::InterfaceConnection(
            self.inner.harness.connect_interface_tools(
                &self.id,
                route_id,
                authenticated_actor_id,
                rights,
            )?,
        ))
    }

    /// What the agent supports for this session, as the ACP declaration.
    pub fn declaration(&self) -> Result<Value> {
        crate::Agent {
            inner: self.inner.clone(),
        }
        .declaration_for(Some(&self.id), false)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    fn scope(&self) -> base::Scope {
        base::Scope {
            actor: self.actor.clone(),
            ..base::Scope::session(&self.id)
        }
    }

    fn require(&self, right: &str) -> Result<()> {
        self.snapshot()?;
        base::require(
            self.inner.harness.as_ref(),
            &base::Scope::session(&self.id),
            right,
        )?;
        base::require(self.inner.harness.as_ref(), &self.scope(), right)?;
        Ok(())
    }

    fn check_actor_option(&self) -> Result<()> {
        if !self.inner.several_actors {
            return Err(Error::new(
                Code::NotSupported,
                "several actors are disabled",
            ));
        }
        Ok(())
    }

    /// Act for another session member. The local principal remains the sponsor.
    pub fn r#as(&self, actor_id: &str) -> Result<Self> {
        if actor_id != LOCAL {
            self.check_actor_option()?;
            if !base::actors(&self.snapshot()?).contains_key(actor_id) {
                return Err(Error::new(Code::NotFound, "unknown actor"));
            }
        }
        Ok(Self {
            actor: actor_id.into(),
            approval_route: base::id(),
            ..self.clone()
        })
    }

    pub async fn join(&self, actor: Actor) -> Result<()> {
        self.join_with(actor, None).await
    }

    pub async fn join_with(&self, actor: Actor, granted_by: Option<&str>) -> Result<()> {
        self.check_actor_option()?;
        let who = match granted_by {
            Some(id) => self.r#as(id)?,
            None => self.clone(),
        };
        who.require("grant")?;
        if actor.id.is_empty()
            || actor.id.starts_with("job:")
            || actor.id == LOCAL
            || actor.id == base::ACP_HOST_ACTOR
            || !matches!(actor.kind.as_str(), "user" | "host" | "agent" | "plugin")
            || !Rights::full().contains(&actor.rights)
        {
            return Err(Error::new(
                Code::InvalidParams,
                "invalid actor identity, kind or rights",
            ));
        }
        let h = self.inner.harness.as_ref();
        if !h
            .authority(&self.id, &who.actor)?
            .intersect(&h.authority(&self.id, LOCAL)?)
            .contains(&actor.rights)
        {
            return Err(Error::new(
                Code::Forbidden,
                "cannot grant a right you do not have",
            ));
        }
        h.append(&who.scope(), "interface.sdk", base::Draft::new("actor.grant", false,
            json!({"actor":actor.id,"kind":actor.kind,"authority":actor.rights,"sponsor":LOCAL})))?;
        base::requests(h)?.presence(&self.id, &actor.id, true);
        h.emit(base::Event::new(
            &who.scope(),
            "actor.joined",
            json!({"actorId":actor.id}),
        ))
        .await?;
        Ok(())
    }

    pub async fn leave(&self, actor_id: &str) -> Result<()> {
        self.check_actor_option()?;
        let data = self.snapshot()?;
        if actor_id != self.actor {
            self.require("grant")?;
        }
        if !base::actors(&data).contains_key(actor_id) || actor_id == LOCAL {
            return Err(Error::new(Code::NotFound, "unknown actor"));
        }
        let h = self.inner.harness.as_ref();
        h.append(
            &self.scope(),
            "interface.sdk",
            base::Draft::new(
                "actor.left",
                false,
                json!({"actorId":actor_id,"sponsor":LOCAL}),
            ),
        )?;
        base::requests(h)?.presence(&self.id, actor_id, false);
        h.emit(base::Event::new(
            &self.scope(),
            "actor.left",
            json!({"actorId":actor_id}),
        ))
        .await?;
        Ok(())
    }

    pub fn set_limit(&self, rights: Option<Rights>) -> Result<()> {
        if !self.inner.session_limits {
            return Err(Error::new(
                Code::NotSupported,
                "session limits are disabled",
            ));
        }
        self.require("administer")?;
        let h = self.inner.harness.as_ref();
        if let Some(rights) = &rights
            && !Rights::full()
                .intersect(&h.authority(&self.id, &self.actor)?)
                .intersect(&h.authority(&self.id, LOCAL)?)
                .contains(rights)
        {
            return Err(Error::new(
                Code::Forbidden,
                "cannot grant a right you do not have",
            ));
        }
        h.append(
            &self.scope(),
            "interface.sdk",
            base::Draft::new("limit", false, json!({"rights":rights,"sponsor":LOCAL})),
        )?;
        Ok(())
    }

    /// List open questions visible to this actor.
    pub fn questions(&self) -> Result<Vec<crate::Question>> {
        self.require("watch")?;
        let h = self.inner.harness.as_ref();
        Ok(base::requests(h)?
            .visible(h, &self.id, &self.actor)?
            .into_iter()
            .filter(|q| q.answerable && q.answer.is_none())
            .map(|q| crate::Question::from_base(&q))
            .collect())
    }

    fn approval_route(&self) -> base::ApprovalRoute {
        base::ApprovalRoute {
            instance: self.approval_route.clone(),
            binding: "sdk".into(),
            actor: self.actor.clone(),
            principal: LOCAL.into(),
            ceiling: Rights::full(),
            live: self.inner.crash.clone(),
        }
    }

    /// Poll on this actor handle. A plain listing does not deliver consent.
    pub async fn questions_present(&self) -> Result<Vec<crate::Question>> {
        self.require("watch")?;
        let h = self.inner.harness.as_ref();
        if h.max_approval_wait_ms().is_none() {
            return Err(Error::new(
                Code::NotSupported,
                "agent does not support waiting approvals",
            ));
        }
        let mut result = Vec::new();
        for q in base::requests(h)?.visible(h, &self.id, &self.actor)? {
            if q.answerable
                && q.answer.is_none()
                && (!q.waits_for_approval()
                    || h.deliver_approval(&self.id, &q.id, &self.approval_route())
                        .await?)
            {
                result.push(crate::Question::from_base(&q));
            }
        }
        Ok(result)
    }

    pub(crate) fn offer_waiting_handler(&self) {
        if self.inner.harness.max_approval_wait_ms().is_none() {
            return;
        }
        let handler = self
            .inner
            .hub
            .session_handlers
            .lock()
            .unwrap()
            .get(&self.id)
            .or(self.inner.hub.on_question.as_ref())
            .cloned();
        let Some(handler) = handler else { return };
        let session = self.clone();
        self.inner.workers.spawn(async move {
            let Ok(list)=session.questions_present().await else{return};
            for q in list.into_iter().filter(|q|q.approval_wait.is_some()) {
                let handler=handler.clone();let s=session.clone(); let key=(s.id.clone(),q.id.clone());
                if !session.inner.hub.waiting_handlers.lock().unwrap().insert(key.clone()){continue}
                session.inner.workers.spawn(async move {
                    let h=&s.inner.harness;
                    let Ok(generation)=h.session_generation(&s.id) else{return};
                    let mut changes=s.inner.hub.events.subscribe();
                    let closed=async {loop{
                        if !h.snapshot(&s.id).and_then(|d|base::questions(&d)).is_ok_and(|qs|qs.iter().any(|v|v.id==q.id && v.answerable)) {break}
                        if matches!(changes.recv().await,Err(tokio::sync::broadcast::error::RecvError::Closed)){break}
                    }};
                    tokio::select!{biased; _=generation.cancelled()=>(),_=s.inner.crash.cancelled()=>(),_=closed=>(),answer=handler(q.clone())=>{let _=s.answer(&q.id,answer).await;}}
                    s.inner.hub.waiting_handlers.lock().unwrap().remove(&key);
                });
            }
        });
    }

    /// Answer an open question by id.
    pub async fn answer(&self, id: &str, answer: crate::Answer) -> Result<()> {
        self.snapshot()?;
        let api: base::Api = self.inner.harness.clone();
        let mut q = None;
        for data in api.list(None)? {
            q = base::questions(&data)?
                .into_iter()
                .find(|q| q.id == id && q.route.contains(&self.id));
            if q.is_some() {
                break;
            }
        }
        let q = q.ok_or_else(|| Error::new(Code::NotFound, "unknown question"))?;
        self.require(if q.kind == base::RequestKind::Approval {
            "approve"
        } else {
            "answer"
        })?;
        if q.waits_for_approval() {
            let (allow, reason) = match answer {
                crate::Answer::Allow => (true, None),
                crate::Answer::Declined { reason } => (false, reason),
                _ => return Err(Error::new(Code::InvalidParams, "expected allow or decline")),
            };
            if !api
                .decide_approval(&self.id, id, &self.approval_route(), allow, reason)
                .await?
            {
                return Err(Error::new(
                    Code::Conflict,
                    "no current delivery on this handle",
                ));
            }
        } else {
            crate::events::answer(api, &self.id, &self.actor, &q, answer).await?;
        }
        if q.scope.session == self.id && q.scope.call.is_some() {
            self.drive();
        }
        Ok(())
    }

    /// Override the agent handler for this session. Use a pending future if the UI
    /// will answer by id; the SDK drops it when the question settles.
    pub fn on_question<F, Fut, Reply>(&self, handler: F) -> Result<()>
    where
        F: Fn(crate::Question) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Reply> + Send + 'static,
        Reply: crate::QuestionReply,
    {
        self.require("answer")?;
        if self.actor != LOCAL {
            return Err(Error::new(
                Code::NotSupported,
                "register handlers on the local session",
            ));
        }
        self.inner.hub.session_handlers.lock().unwrap().insert(
            self.id.clone(),
            Arc::new(move |q| {
                let reply = handler(q);
                Box::pin(async move { reply.await.into_answer() })
            }),
        );
        base::requests(self.inner.harness.as_ref())?.presence(&self.id, LOCAL, true);
        self.offer_waiting_handler();
        Ok(())
    }

    /// Proposals and parked reports the actor can see.
    pub async fn proposals(&self) -> Result<Vec<Proposal>> {
        self.require("watch")?;
        let data = self.snapshot()?;
        let mut proposals = Vec::new();
        for (id, entry) in data.pending_inputs() {
            let Some(value) = &entry.content else {
                continue;
            };
            if value["timing"] != "propose"
                && !(value["parked"] == true && value["releasedBy"].is_null())
            {
                continue;
            }
            let entry_view = base::portable::public_entry(entry, &data)?;
            let proposal = json!({"inputId":id,"actorId":entry.scope.actor,
                "content":entry_view["data"]["content"],"time":entry.at});
            if let Some(value) = self
                .inner
                .harness
                .output(
                    &self.scope(),
                    base::Output {
                        recipient: self.actor.clone(),
                        value: proposal,
                        stream: None,
                        end: true,
                    },
                )
                .await?
            {
                proposals.push(serde_json::from_value(value)?);
            }
        }
        Ok(proposals)
    }

    /// Withdraw a proposal as its proposer or as an actor with `input`.
    pub async fn withdraw(&self, input_id: &str) -> Result<()> {
        let sponsor = if self.actor == LOCAL {
            &self.actor
        } else {
            LOCAL
        };
        Ok(self
            .inner
            .harness
            .withdraw_proposal(&self.scope(), sponsor, input_id)
            .await?)
    }

    /// Release a proposal and return its new disposition without waiting for a turn.
    /// Pass `None` for the default options, or set `declined` to hand it back.
    pub async fn release(
        &self,
        input_id: &str,
        timing: Timing,
        options: impl Into<ReleaseOptions>,
    ) -> Result<InputReceipt> {
        self.require("input")?;
        let taken = self
            .inner
            .harness
            .release(
                &self.scope(),
                input_id,
                timing.into(),
                options.into().declined,
            )
            .await?;
        if taken != "handedBack" {
            drop(self.drive());
        }
        Ok(InputReceipt {
            input_id: input_id.into(),
            duplicate: false,
            erased: false,
            taken: taken.into(),
        })
    }

    /// Admit input with timing `now` and wait for the turn that takes it.
    pub async fn prompt(&self, input: impl Into<PromptInput>) -> Result<PromptResult> {
        self.prompt_with(input, None).await
    }

    /// Prompt with options. Retrying a key waits for its original turn.
    pub async fn prompt_with(
        &self,
        input: impl Into<PromptInput>,
        options: impl Into<PromptOptions>,
    ) -> Result<PromptResult> {
        let mut events = self.inner.hub.events.subscribe();
        let interruption = self.inner.harness.writer_interruption(&self.id)?;
        let options = options.into();
        let receipt = self
            .admit(input.into(), Timing::Now, options.key, options.result)
            .await?;
        if receipt.taken == "handled" {
            return Ok(no_turn(receipt.input_id, Disposition::Handled));
        }
        let mut run = self.drive();
        loop {
            if let Some(result) = self.result(&receipt.input_id)? {
                return Ok(result);
            }
            tokio::select! {
                _ = interruption.cancelled() => return Err(writer_interrupted()),
                update = events.recv() => {
                    if matches!(update, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                        return Err(Error::new(Code::Lost, "the event stream closed"));
                    }
                }
                done = &mut run => {
                    done.map_err(|e| Error::new(Code::Lost, e.to_string()))??;
                    return Ok(self.result(&receipt.input_id)?
                        .unwrap_or_else(|| no_turn(receipt.input_id, Disposition::HandedBack)));
                }
            }
        }
    }

    /// Replay committed entries after a cursor (or from the beginning), then follow live events.
    /// If the reader falls behind, the stream ends with `lost` and `data.fromEntry`.
    pub fn events(&self, from_entry: Option<&str>) -> Result<EventStream> {
        // Subscribe first so commits during snapshot/replay are never missed.
        let events = self.inner.hub.events.subscribe();
        let data = self.snapshot()?;
        let mut cursor = from_entry.map(str::to_owned);
        let at = if let Some(id) = from_entry {
            data.entries
                .iter()
                .position(|e| e.id == id && e.writer != "rust.derived")
                .ok_or_else(|| Error::new(Code::NotFound, "unknown event cursor"))?
                + 1
        } else {
            0
        };
        self.require("watch")?;
        let existing = data
            .entries
            .iter()
            .map(|e| e.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let rows = data.entries[at..]
            .iter()
            .filter(|e| e.writer != "rust.derived")
            .map(|e| {
                Ok((
                    e.scope.clone(),
                    e.at,
                    base::portable::public_entry(e, &data)?,
                ))
            })
            .collect::<base::Result<Vec<_>>>()?;
        let me = self.clone();
        Ok(Box::pin(async_stream::try_stream! {
            let mut events = events;
            for (scope, time, row) in rows {
                let entry_id = row["id"].as_str().map(str::to_owned);
                if let Some(view) = me.gate_entry(&scope, row).await? {
                    cursor = entry_id;
                    yield Event::new(&scope, time, "entry", json!({"entry":view}));
                }
            }
            loop {
                match events.recv().await {
                    Ok(event) if event.session_id == me.id => {
                        me.require("watch")?;
                        let Some(event) = me.gate_event(event).await? else { continue; };
                        if event.event_type == "entry" {
                            let entry = &event.data["entry"];
                            let Some(id) = entry["id"].as_str() else { continue };
                            if existing.contains(id) { continue; }
                            cursor = Some(id.into());
                        }
                        let ended = event.event_type == "sessionEnded";
                        yield event;
                        if ended { break; }
                    }
                    Ok(_) => (),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        Err(Error::new(Code::Lost, "event reader fell behind; resume with events(from_entry)")
                            .with_data(json!({"fromEntry":cursor})))?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }))
    }

    /// The events of the turn this input starts, ending with its `TurnEnded`.
    pub async fn prompt_stream(&self, input: impl Into<PromptInput>) -> Result<EventStream> {
        self.prompt_stream_with(input, PromptOptions::default())
            .await
    }

    pub async fn prompt_stream_with(
        &self,
        input: impl Into<PromptInput>,
        options: PromptOptions,
    ) -> Result<EventStream> {
        let events = self.inner.hub.events.subscribe();
        let interruption = self.inner.harness.writer_interruption(&self.id)?;
        let receipt = self
            .admit(input.into(), Timing::Now, options.key, options.result)
            .await?;
        if receipt.taken == "handled" {
            return Ok(Box::pin(futures_util::stream::empty()));
        }
        let me = self.clone();
        let run = self.drive();
        Ok(Box::pin(futures_util::stream::unfold(
            Some((events, run, receipt.input_id, me)),
            move |state| {
                let interruption = interruption.clone();
                async move {
                    let (mut events, mut run, input, me) = state?;
                    loop {
                        tokio::select! {
                            biased;
                            update = events.recv() => match update {
                                Ok(e) if e.session_id == me.id && e.turn_id.is_some() => {
                                    let data = match me.snapshot() {
                                        Ok(data) => data,
                                        Err(e) => return Some((Err(e), None)),
                                    };
                                    if e.turn_id == input_turn(&data, &input) {
                                        let ended = e.event_type == "turnEnded";
                                        match me.gate_event(e).await {
                                            Ok(Some(event)) => return Some((Ok(event), (!ended).then_some((events, run, input, me)))),
                                            Ok(None) if ended => return None,
                                            Ok(None) => continue,
                                            Err(e) => return Some((Err(e), None)),
                                        }
                                    }
                                }
                                Ok(_) => (),
                                Err(e) => return Some((Err(Error::new(Code::Lost, e.to_string())), None)),
                            },
                            _ = interruption.cancelled() => return Some((Err(writer_interrupted()), None)),
                            done = &mut run => match done {
                                Ok(Ok(())) => return None,
                                Ok(Err(e)) => return Some((Err(e), None)),
                                Err(e) => return Some((Err(Error::new(Code::Lost, e.to_string())), None)),
                            }
                        }
                    }
                }
            },
        )))
    }

    fn snapshot(&self) -> Result<base::SessionData> {
        self.inner
            .harness
            .snapshot(&self.id)
            .map_err(|_| Error::new(Code::NotOpen, "session is not open"))
    }

    fn result(&self, id: &str) -> Result<Option<PromptResult>> {
        let data = self.snapshot()?;
        if let Some(turn) = input_turn(&data, id)
            && !self.inner.harness.is_turn_running(&self.id, &turn)
            && let Some(end) = data
                .entries
                .iter()
                .find(|e| e.kind == "turn.end" && e.scope.turn.as_ref() == Some(&turn))
        {
            let result = serde_json::from_value(end.content.clone().unwrap_or_default())?;
            return Ok(Some(from_turn(id.into(), &result, Some(turn), &data)));
        }
        Ok(data
            .entries
            .iter()
            .any(|e| {
                e.kind == "input.returned" && e.content.as_ref().is_some_and(|c| c["input"] == id)
            })
            .then(|| no_turn(id.into(), Disposition::HandedBack)))
    }

    async fn admit(
        &self,
        input: PromptInput,
        timing: Timing,
        key: Option<String>,
        shape: Option<Value>,
    ) -> Result<InputReceipt> {
        if matches!(timing, Timing::Propose) {
            self.check_actor_option()?;
        }
        self.require(if matches!(timing, Timing::Propose) {
            "propose"
        } else {
            "input"
        })?;
        let sponsor = (self.actor != LOCAL).then_some(LOCAL);
        let h = &self.inner.harness;
        if let Some(shape) = &shape {
            base::schema::compile(shape)
                .map_err(|e| Error::new(Code::InvalidParams, e.to_string()))?;
        }
        let content = input.content();
        base::wire::parts(&content).map_err(|e| Error::new(Code::InvalidParams, e.to_string()))?;
        let receipt = h
            .submit_content_as(&self.scope(), sponsor, content, timing.into(), key, shape)
            .await?;
        let taken = if receipt.erased {
            "handedBack".into()
        } else {
            self.snapshot()?
                .entries
                .iter()
                .find(|e| {
                    e.id == receipt.input
                        || e.content
                            .as_ref()
                            .is_some_and(|c| c["inputId"] == receipt.input)
                })
                .map(|e| {
                    if e.kind == "command" {
                        "handled"
                    } else {
                        e.content
                            .as_ref()
                            .and_then(|c| c["taken"].as_str())
                            .unwrap_or("now")
                    }
                })
                .unwrap_or("now")
                .to_owned()
        };
        Ok(InputReceipt {
            input_id: receipt.input,
            duplicate: receipt.duplicate,
            erased: receipt.erased,
            taken,
        })
    }

    pub(crate) fn drive(&self) -> tokio::task::JoinHandle<Result<()>> {
        let me = self.clone();
        self.driver
            .scheduled
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let scheduled = Scheduled(self.driver.clone());
        self.inner.workers.spawn(async move {
            let _scheduled = scheduled;
            tokio::select! {
                biased;
                _ = me.inner.crash.cancelled() => Err(Error::new(Code::Lost, "the agent was restarted")),
                result = async {
                    let _lock = me.driver.run.lock().await;
                    while me.inner.harness.run_next(&me.id).await?.is_some() {}
                    Ok(())
                } => result,
            }
        })
    }

    /// Admit input without waiting for its turn.
    pub async fn send(
        &self,
        input: impl Into<PromptInput>,
        timing: Timing,
    ) -> Result<InputReceipt> {
        self.send_with(input, timing, None).await
    }

    pub async fn send_with(
        &self,
        input: impl Into<PromptInput>,
        timing: Timing,
        key: Option<String>,
    ) -> Result<InputReceipt> {
        let receipt = self.admit(input.into(), timing, key, None).await?;
        if !receipt.duplicate && !matches!(receipt.taken.as_str(), "handled" | "proposed") {
            // Dropping the handle detaches the waiter, not the work.
            drop(self.drive());
        }
        Ok(receipt)
    }

    /// Cancel the current turn and hand queued inputs back.
    pub async fn cancel(&self) -> Result<Vec<HandedBack>> {
        self.require("cancel")?;
        let returned = self.inner.harness.cancel(&self.id).await?;
        // A cancellation can make a previously ended turn ready for its
        // result-only continuation. Closing uses cancel directly, without
        // starting another turn before detaching the session.
        if self.inner.harness.has_interface_tools() {
            self.drive();
        }
        Ok(returned
            .into_iter()
            .map(|i| HandedBack {
                input_id: i.id,
                content: serde_json::json!([{"type":"text","text":i.text}]),
            })
            .collect())
    }

    pub fn settings(&self) -> Result<Value> {
        self.require("watch")?;
        Ok(base::portable::settings_to_wire(&self.snapshot()?.settings))
    }

    /// This agent refuses to change settings while a turn is running.
    pub fn set_setting(&self, key: &str, value: Value) -> Result<()> {
        self.require("settings")?;
        if key.starts_with('_') {
            return Err(Error::new(
                Code::InvalidParams,
                "internal settings cannot be changed",
            ));
        }
        if self.inner.harness.is_running(&self.id) {
            return Err(Error::new(
                Code::Busy,
                "settings cannot change during a turn",
            ));
        }
        let patch = base::portable::settings_from_wire(&serde_json::json!({key: value}));
        if key == "model" {
            let name = patch["model"]
                .as_str()
                .ok_or_else(|| Error::new(Code::InvalidRequest, "invalid model"))?;
            crate::agent::require_model(self.inner.harness.as_ref(), name)?;
        }
        self.inner.harness.settings(&self.scope(), patch)?;
        Ok(())
    }

    /// Erase kept entries and their known copies using the installed history store.
    pub async fn erase(&self, entries: Vec<String>) -> Result<crate::ErasureReport> {
        self.require("erase")?;
        let harness = self.inner.harness.as_ref();
        if harness.declaration()?["erasure"] != true {
            return Err(Error::new(
                Code::NotSupported,
                "history store does not support erasure",
            ));
        }
        let data = self.snapshot()?;
        if entries.is_empty() {
            return Err(Error::new(Code::InvalidParams, "entry ids are required"));
        }
        let entries: std::collections::BTreeSet<_> = entries.into_iter().collect();
        for id in &entries {
            let entry = data
                .entries
                .iter()
                .find(|entry| &entry.id == id)
                .ok_or_else(|| Error::new(Code::NotFound, "unknown erasure target"))?;
            if base::authority_record(entry) || entry.kind == "erasure" {
                return Err(Error::new(Code::Forbidden, "protected erasure target"));
            }
        }
        if harness.is_running(&self.id) {
            return Err(Error::new(Code::Busy, "erasure requires an idle session"));
        }
        let report = harness
            .erase(&self.scope(), entries.into_iter().collect())
            .await?;
        let mut out = crate::ErasureReport {
            out_of_reach: report.out_of_reach,
            ..Default::default()
        };
        for (session_id, id) in report
            .qualified
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
        {
            if session_id != self.id {
                out.out_of_reach.push("copies in other sessions".into());
                continue;
            }
            let pair = crate::ErasedEntry { session_id, id };
            if report.pending.contains(&pair.id) {
                out.pending.push(pair);
            } else {
                out.erased.push(pair);
            }
        }
        out.out_of_reach.sort();
        out.out_of_reach.dedup();
        Ok(out)
    }

    /// Fork at the current position.
    pub fn fork(&self) -> Result<Session> {
        self.fork_with(None)
    }

    /// Fork at a recorded entry, or at the current position.
    pub fn fork_with(&self, entry_id: Option<&str>) -> Result<Session> {
        self.require("input")?;
        let data = self.snapshot()?;
        if entry_id.is_some_and(|id| !data.entries.iter().any(|e| e.id == id)) {
            return Err(Error::new(Code::NotFound, "unknown fork point"));
        }
        let id = self
            .inner
            .harness
            .fork(&self.scope(), entry_id.map(str::to_owned))?;
        let agent = crate::Agent {
            inner: self.inner.clone(),
        };
        agent.attach(&id)?;
        Ok(Session {
            actor: self.actor.clone(),
            ..Session::new(self.inner.clone(), id)
        })
    }

    /// This actor's view of the latest settled turn. Does not wait for running work.
    pub async fn last_turn(&self) -> Result<Option<PromptResult>> {
        self.require("watch")?;
        let data = self.inner.harness.snapshot(&self.id)?;
        let Some(end) = data.entries.iter().rev().find(|e| e.kind == "turn.end") else {
            return Ok(None);
        };
        let result: base::TurnResult =
            serde_json::from_value(end.content.clone().unwrap_or_default())?;
        let result = from_turn(
            data.entries
                .iter()
                .find(|e| e.kind == "input" && e.scope.turn == end.scope.turn)
                .and_then(|e| e.content.as_ref())
                .and_then(|v| v["inputId"].as_str())
                .unwrap_or_default()
                .into(),
            &result,
            end.scope.turn.clone(),
            &data,
        );
        let scope = base::Scope {
            actor: self.actor.clone(),
            ..end.scope.clone()
        };
        let gated = self
            .inner
            .harness
            .output(
                &scope,
                base::Output {
                    recipient: self.actor.clone(),
                    value: json!({"method":"lastTurn","result":result}),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .ok_or_else(|| Error::new(Code::Withheld, "last turn withheld"))?;
        let mut result: PromptResult = serde_json::from_value(gated["result"].clone())?;
        for tool in &mut result.tool_results {
            tool.text = base::wire::text(&json!(tool.content));
        }
        Ok(Some(result))
    }

    /// Whether this session is currently driving a turn.
    pub fn is_running(&self) -> bool {
        use base::AgentApi;
        self.inner.harness.is_running(&self.id)
    }

    /// Wait for admitted work to finish without admitting input or closing
    /// the session. Proposed or parked input does not keep it busy.
    pub async fn wait_idle(&self) -> Result<()> {
        self.require("watch")?;
        let mut events = self.inner.hub.events.subscribe();
        loop {
            {
                let _run = self.driver.run.lock().await;
                let data = self.snapshot()?;
                let queued = data.pending_inputs().iter().any(|(_, entry)| {
                    entry.content.as_ref().is_some_and(|v| {
                        (v["parked"] != true || !v["releasedBy"].is_null())
                            && v["taken"] != "proposed"
                            && v["timing"] != "propose"
                    })
                });
                if !self.is_running()
                    && !queued
                    && self
                        .driver
                        .scheduled
                        .load(std::sync::atomic::Ordering::Acquire)
                        == 0
                {
                    return Ok(());
                }
            }
            tokio::select! {
                _ = self.inner.crash.cancelled() => return Err(Error::new(Code::Lost, "the agent was restarted")),
                _ = events.recv() => (),
                // A driver may release its lock after its last event has
                // already been read, or settle input without a live event.
                _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => (),
            }
        }
    }

    /// Run a tool on behalf of the local actor, outside the model's conversation.
    pub async fn call_tool(&self, name: &str, input: Value) -> Result<ToolResult> {
        self.require("tools")?;
        let data = self.snapshot()?;
        let api: base::Api = self.inner.harness.clone();
        let runtime = base::session_runtime(api.as_ref(), &data)?;
        let result = runtime
            .tool(api, self.scope(), base::ToolCall::new(name, input))
            .await?;
        Ok(ToolResult::from_base(name.into(), result))
    }

    /// Move to a recorded entry without restoring the working environment.
    pub async fn move_to(&self, entry_id: &str) -> Result<Vec<String>> {
        self.move_to_with(entry_id, MoveOptions::default()).await
    }

    /// Move to a recorded entry, optionally restoring its saved working-environment point.
    pub async fn move_to_with(&self, entry_id: &str, options: MoveOptions) -> Result<Vec<String>> {
        self.require("settings")?;
        let h = self.inner.harness.as_ref();
        if !self
            .snapshot()?
            .entries
            .iter()
            .any(|entry| entry.id == entry_id)
        {
            return Err(Error::new(Code::NotFound, "unknown position"));
        }
        if options.rewind {
            if h.declaration()?["rewinding"] != true {
                return Err(Error::new(
                    Code::NotSupported,
                    "working environment cannot rewind",
                ));
            }
            return Ok(h.rewind(&self.scope(), entry_id.into()).await?);
        }
        h.move_position(&self.scope(), Some(entry_id.into()))?;
        Ok(vec![])
    }

    /// This actor's gated view of the recorded entries, oldest first.
    pub async fn history(&self) -> Result<Vec<Value>> {
        self.require("watch")?;
        let data = self.snapshot()?;
        let mut rows = Vec::new();
        for e in data.entries.iter().filter(|e| e.writer != "rust.derived") {
            let row = base::portable::public_entry(e, &data)?;
            if let Some(view) = self.gate_entry(&e.scope, row).await? {
                rows.push(view);
            }
        }
        Ok(rows)
    }

    async fn gate_event(&self, event: Event) -> Result<Option<Event>> {
        self.require("watch")?;
        let scope = self.scope();
        self.inner
            .harness
            .output(
                &scope,
                base::Output {
                    recipient: self.actor.clone(),
                    value: json!(event),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .map(serde_json::from_value)
            .transpose()
            .map_err(Into::into)
    }

    async fn gate_entry(&self, scope: &base::Scope, row: Value) -> Result<Option<Value>> {
        self.require("watch")?;
        let scope = base::Scope {
            actor: self.actor.clone(),
            ..scope.clone()
        };
        Ok(self
            .inner
            .harness
            .output(
                &scope,
                base::Output {
                    recipient: self.actor.clone(),
                    value: json!({"entry":row}),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .and_then(|mut view| view.get_mut("entry").map(Value::take)))
    }

    /// List the commands available to the local actor.
    pub fn commands(&self) -> Result<Vec<String>> {
        self.require("watch")?;
        Ok(self.inner.harness.commands())
    }

    /// Run a command without starting a turn. The result is text, if any.
    pub async fn run_command(&self, line: &str) -> Result<Option<String>> {
        self.require("input")?;
        let (name, args) = crate::plugin::command_line(line);
        if !self.commands()?.iter().any(|command| command == name) {
            return Err(Error::new(
                Code::NotFound,
                format!("unknown command {name}"),
            ));
        }
        let value = self
            .inner
            .harness
            .command(&self.scope(), name, args)
            .await?;
        Ok(if let Some(content) = value.get("content") {
            Some(base::wire::text(content))
        } else if value.as_object().is_some_and(|object| object.is_empty()) || value.is_null() {
            None
        } else {
            Some(value.to_string())
        })
    }

    /// Close the session after cancelling and settling any queued or running work.
    pub async fn close(&self) -> Result<()> {
        self.require("cancel")?;
        self.close_owned().await
    }

    pub(crate) async fn close_owned(&self) -> Result<()> {
        self.inner.harness.cancel_for_close(&self.id).await?;
        let _run = self.driver.run.lock().await;
        self.inner.harness.close(&self.id).await?;
        self.inner
            .hub
            .session_handlers
            .lock()
            .unwrap()
            .remove(&self.id);
        base::requests(self.inner.harness.as_ref())?.presence(&self.id, LOCAL, false);
        Ok(())
    }
}

pub(crate) fn input_turn(data: &base::SessionData, id: &str) -> Option<String> {
    data.entries
        .iter()
        .find(|e| {
            matches!(e.kind.as_str(), "input" | "turn.end")
                && e.content.as_ref().is_some_and(|c| c["inputId"] == id)
        })
        .and_then(|e| e.scope.turn.clone())
}

fn writer_interrupted() -> Error {
    Error::new(Code::Lost, "session writer interrupted; reopen to recover")
}

fn no_turn(input_id: String, disposition: Disposition) -> PromptResult {
    PromptResult {
        input_id,
        disposition,
        outcome: None,
        text: String::new(),
        value: None,
        turn_id: None,
        open_tool_calls: vec![],
        usage: None,
        tool_results: vec![],
    }
}

fn from_turn(
    input_id: String,
    result: &base::TurnResult,
    turn: Option<String>,
    data: &base::SessionData,
) -> PromptResult {
    let outcome = match result.outcome {
        base::Outcome::Completed => Outcome::Completed,
        base::Outcome::Cancelled => Outcome::Cancelled,
        base::Outcome::Failed => Outcome::Failed {
            error: result.error.clone().unwrap_or_default(),
        },
        base::Outcome::Limit => Outcome::Limit {
            limit: result.limit.clone().unwrap_or_default(),
        },
    };
    let calls: Vec<base::ToolCall> = data
        .entries
        .iter()
        .filter(|e| e.kind == "tool.call" && e.scope.turn == turn)
        .filter_map(|e| serde_json::from_value::<base::ToolCall>(e.content.clone()?).ok())
        .filter(|call| call.started_by == "model")
        .collect();
    let tool_results = data
        .entries
        .iter()
        .filter(|e| e.kind == "tool.result" && e.scope.turn == turn)
        .filter_map(|e| serde_json::from_value::<base::ToolResult>(e.content.clone()?).ok())
        .collect::<Vec<_>>();
    let tool_results = calls
        .iter()
        .filter_map(|c| {
            tool_results
                .iter()
                .find(|r| r.call == c.id)
                .map(|r| ToolResult::from_base(c.name.clone(), r.clone()))
        })
        .collect();
    PromptResult {
        input_id,
        disposition: Disposition::Turn,
        outcome: Some(outcome),
        text: result.text.clone(),
        value: result.value.clone(),
        turn_id: turn,
        open_tool_calls: result.open_calls.iter().map(|c| c.id.clone()).collect(),
        usage: Some(result.usage.clone().into()),
        tool_results,
    }
}
