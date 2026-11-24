//! Plugins: a named bundle of registrations (docs/sdk/api.md#plugins).
use crate::{
    Code, Error, HookRule, Result,
    hooks::Hook,
    tool::{Backend, Tool, ToolContext, execute},
};
use agent_api as base;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::{future::Future, sync::Arc};
use tokio_util::sync::CancellationToken;

type Stop = Arc<dyn Fn() -> BoxFuture<'static, Result<()>> + Send + Sync>;
type Setup = Arc<dyn Fn(&mut Registrar) -> Result<()> + Send + Sync>;
type CommandHandler =
    Arc<dyn Fn(String, CommandContext) -> BoxFuture<'static, Result<Option<String>>> + Send + Sync>;

type LocalHook<Input, Output> =
    Arc<dyn Fn(Input) -> BoxFuture<'static, Result<Output>> + Send + Sync>;

/// A session-scoped tool catalog, queried before dispatch.
pub trait ToolSource: Send + Sync + 'static {
    /// The full catalog. A session-independent source receives an empty id.
    fn tools(&self, session_id: &str) -> Vec<Tool>;
    fn per_session(&self) -> bool {
        true
    }
    /// Keep the notifier and call it after changing the catalog, before replying.
    fn catalog_notifier(&self, _notifier: ToolsChanged) {}
}

#[derive(Clone)]
pub struct ToolsChanged(pub(crate) Arc<dyn Fn() + Send + Sync>);
impl ToolsChanged {
    pub fn changed(&self) {
        (self.0)();
    }
}

#[derive(Clone, Debug)]
pub struct SessionPrepare {
    pub session_id: String,
    pub project: std::path::PathBuf,
}

/// A named bundle of parts, added to an agent or served over the plugin binding.
#[derive(Clone)]
pub struct Plugin {
    pub(crate) name: String,
    pub(crate) replaces: Vec<String>,
    pub(crate) config: Value,
    pub(crate) local_items: Vec<String>,
    setups: Vec<Setup>,
    pub(crate) stop: Option<Stop>,
}

/// What a plugin registers, once, when it is loaded.
pub struct Registrar {
    config: Value,
    pub(crate) tools: Vec<Tool>,
    pub(crate) providers: Vec<Arc<dyn crate::Provider>>,
    pub(crate) hooks: Vec<Hook>,
    pub(crate) local_hooks: Vec<crate::hooks::LocalRegistration>,
    pub(crate) commands: Vec<Command>,
    pub(crate) jobs: Option<crate::jobs::Owner>,
    defined: Vec<(String, HookRule, crate::DefinedHook)>,
    subscriptions: Vec<(String, crate::Order, crate::hooks::LocalHandle)>,
    pub(crate) sources: Vec<(String, Arc<dyn ToolSource>)>,
    prepare: Vec<LocalHook<SessionPrepare, ()>>,
    pub(crate) environment: Option<Arc<dyn base::WorkingEnvironment>>,
    pub(crate) portable_environment: Option<crate::environment::Adapter>,
    runtime: Option<Arc<dyn base::Runtime>>,
    pub(crate) portable_runtime: Option<crate::runtime::Adapter>,
    history: Option<crate::History>,
    credentials: Option<Arc<dyn crate::CredentialStore>>,
    configuration: Option<Arc<dyn crate::Configuration>>,
    pub(crate) interfaces: Vec<Arc<dyn crate::Interface>>,
}

#[derive(Clone)]
pub struct Command {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) local: bool,
    uses_model: bool,
    pub(crate) run: CommandHandler,
}

#[derive(Clone)]
pub struct CommandContext {
    pub session_id: String,
    pub actor_id: String,
    pub cancelled: CancellationToken,
    pub(crate) model: Option<Arc<CommandModel>>,
    pub(crate) work: ToolContext,
    pub(crate) can_ask: bool,
}

pub(crate) struct CommandModel {
    api: base::Api,
    scope: base::Scope,
    done: CancellationToken,
    sequence: tokio::sync::Mutex<()>,
}

impl CommandContext {
    /// Make an auxiliary request with the session's model. This never dispatches tools.
    pub async fn request_model(
        &self,
        request: crate::ModelRequest,
    ) -> Result<crate::AssistantMessage> {
        let model = self.model.as_ref().ok_or_else(|| {
            Error::new(
                Code::NotSupported,
                "command must register uses_model in process",
            )
        })?;
        let _sequential = model.sequence.lock().await;
        if model.done.is_cancelled() {
            return Err(Error::new(
                Code::InvalidRequest,
                "command context has settled",
            ));
        }
        let attempt = request_from_command(model, request, self.cancelled.child_token());
        tokio::select! {
            biased;
            _ = model.done.cancelled() => Err(Error::new(Code::InvalidRequest, "command context has settled")),
            result = attempt => result,
        }
    }

    pub fn project(&self) -> &std::path::Path {
        &self.work.project
    }
    pub fn step_id(&self) -> Option<&str> {
        self.work.step_id()
    }

    /// Ask an actor from an in-process-only command.
    pub async fn ask(&self, question: crate::Ask) -> Result<crate::Answer> {
        if !self.can_ask {
            return Err(cannot_serve("command questions"));
        }
        self.work.ask(question).await
    }

    /// Ask from an in-process command and decline if the wait expires.
    /// A command has no turn in which to leave the question open.
    pub async fn ask_with(
        &self,
        question: crate::Ask,
        wait: std::time::Duration,
    ) -> Result<crate::Answer> {
        if !self.can_ask {
            return Err(cannot_serve("command questions"));
        }
        let ms = wait.as_millis();
        if ms > 9_007_199_254_740_991 {
            return Err(Error::new(
                Code::InvalidRequest,
                "question wait is not representable",
            ));
        }
        self.work.ask_inner(question, Some(ms as u64)).await
    }

    pub async fn call_hook(
        &self,
        hook: &crate::DefinedHook,
        value: Value,
    ) -> Result<crate::HookReply> {
        self.work.call_hook(hook, value).await
    }

    /// The working environment scoped to this command.
    pub fn environment(&self) -> Result<crate::ToolEnvironment<'_>> {
        self.work.check()?;
        Ok(self.work.environment())
    }

    pub async fn start_job(
        &self,
        kind: &str,
        detail: Value,
        key: Option<&str>,
    ) -> Result<crate::JobStart> {
        self.work.start_job(kind, detail, key).await
    }

    pub async fn history(&self, after: Option<&str>) -> Result<crate::HistoryPage> {
        self.work.history(after).await
    }

    pub async fn emit(&self, kind: &str, data: Value) -> Result<()> {
        self.work.emit(kind, data).await
    }

    pub fn log(&self, message: impl std::fmt::Display) {
        eprintln!("command in session {}: {message}", self.session_id);
    }
}
impl Command {
    pub fn new<F, Fut>(name: impl Into<String>, description: impl Into<String>, handler: F) -> Self
    where
        F: Fn(String, CommandContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<String>>> + Send + 'static,
    {
        Self {
            name: name.into(),
            description: description.into(),
            local: false,
            uses_model: false,
            run: Arc::new(move |args, cx| Box::pin(handler(args, cx))),
        }
    }
    /// Enable scoped auxiliary inference. Such commands cannot be served.
    pub fn uses_model(mut self) -> Self {
        self.uses_model = true;
        self.local = true;
        self
    }

    pub fn in_process_only(mut self) -> Self {
        self.local = true;
        self
    }
}

impl Plugin {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            replaces: vec![],
            config: json!({}),
            local_items: vec![],
            setups: vec![],
            stop: None,
        }
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn replaces(mut self, item: impl Into<String>) -> Self {
        self.replaces.push(item.into());
        self
    }
    pub fn config(mut self, config: Value) -> Self {
        self.config = config;
        self
    }
    pub fn tool(mut self, tool: Tool) -> Self {
        if tool.in_process_only {
            self.local_items.push(format!("tool:{}", tool.name()));
        }
        self.setup(move |r| {
            r.tool(tool.clone());
            Ok(())
        })
    }
    pub fn provider(self, provider: impl crate::Provider) -> Self {
        let provider: Arc<dyn crate::Provider> = Arc::new(provider);
        self.setup(move |r| {
            r.providers.push(provider.clone());
            Ok(())
        })
    }
    pub fn command(mut self, command: Command) -> Self {
        if command.local {
            self.local_items.push(format!("command:{}", command.name));
        }
        self.setup(move |r| {
            r.command(command.clone());
            Ok(())
        })
    }
    /// Define a hook point owned by this plugin. It cannot cross the binding.
    pub fn define_hook(mut self, name: impl Into<String>, rule: HookRule) -> Self {
        let name = name.into();
        self.local_items.push(format!("hook:{name}"));
        self.setup(move |r| {
            r.define_hook(&name, rule);
            Ok(())
        })
    }
    /// Register a source whose catalog may change or vary by session.
    pub fn tool_source(self, name: impl Into<String>, source: impl ToolSource) -> Self {
        let name = name.into();
        let source: Arc<dyn ToolSource> = Arc::new(source);
        self.setup(move |r| {
            r.add_source(name.clone(), source.clone());
            Ok(())
        })
    }

    /// Run before a session is used, including before crash recovery.
    pub fn on_session_prepare<F, Fut>(self, prepare: F) -> Self
    where
        F: Fn(SessionPrepare) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let prepare: LocalHook<SessionPrepare, ()> = Arc::new(move |p| Box::pin(prepare(p)));
        self.setup(move |r| {
            r.prepare.push(prepare.clone());
            Ok(())
        })
    }

    pub fn setup<F>(mut self, setup: F) -> Self
    where
        F: Fn(&mut Registrar) -> Result<()> + Send + Sync + 'static,
    {
        self.setups.push(Arc::new(setup));
        self
    }
    /// Release this plugin's resources when the agent or its served instance stops.
    pub fn stop<F, Fut>(mut self, stop: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        self.stop = Some(Arc::new(move || Box::pin(stop())));
        self
    }
    pub(crate) fn register(&self, config: &Value) -> Result<Registrar> {
        let mut r = Registrar {
            config: config.clone(),
            tools: vec![],
            providers: vec![],
            hooks: vec![],
            local_hooks: vec![],
            commands: vec![],
            defined: vec![],
            subscriptions: vec![],
            sources: vec![],
            prepare: vec![],
            environment: None,
            portable_environment: None,
            runtime: None,
            portable_runtime: None,
            history: None,
            jobs: None,
            credentials: None,
            configuration: None,
            interfaces: vec![],
        };
        for setup in &self.setups {
            setup(&mut r)?;
        }
        r.validate_sources()?;
        Ok(r)
    }
}

impl Registrar {
    pub fn config(&self) -> &Value {
        &self.config
    }
    pub fn tool(&mut self, tool: Tool) {
        self.tools.push(tool);
    }
    pub fn provider(&mut self, provider: impl crate::Provider) {
        self.providers.push(Arc::new(provider));
    }
    pub fn command(&mut self, command: Command) {
        self.commands.push(command);
    }
    pub fn jobs(&mut self, owner: impl crate::JobOwner) -> Result<()> {
        set_part(&mut self.jobs, crate::jobs::Owner::new(owner), "job owner")
    }
    pub fn define_hook(&mut self, name: impl Into<String>, rule: HookRule) -> crate::DefinedHook {
        let hook = crate::DefinedHook(Arc::new(std::sync::OnceLock::new()));
        self.defined.push((name.into(), rule, hook.clone()));
        hook
    }

    /// Subscribe to an in-process plugin-defined hook.
    pub fn on_hook<F, Fut>(&mut self, name: impl Into<String>, order: crate::Order, f: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<crate::HookAnswer>> + Send + 'static,
    {
        self.on_hook_context(name, order, move |value, _| f(value));
    }

    /// Subscribe to a custom hook with access to its scoped callbacks.
    pub fn on_hook_context<F, Fut>(&mut self, name: impl Into<String>, order: crate::Order, f: F)
    where
        F: Fn(Value, crate::HookContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<crate::HookAnswer>> + Send + 'static,
    {
        self.subscriptions.push((
            name.into(),
            order,
            Arc::new(move |value, context| {
                let result = f(value, context);
                Box::pin(async move { Ok(result.await?.native()) })
            }),
        ));
    }
    pub fn tools(&mut self, id: impl Into<String>, source: impl ToolSource) {
        self.add_source(id.into(), Arc::new(source));
    }
    fn add_source(&mut self, id: String, source: Arc<dyn ToolSource>) {
        self.sources.push((id, source));
    }
    pub(crate) fn validate_sources(&self) -> Result<()> {
        let mut unique = std::collections::BTreeSet::new();
        for (id, _) in &self.sources {
            if id.is_empty() || id == "tools" || !unique.insert(id) {
                return Err(Error::new(
                    Code::InvalidComposition,
                    format!("invalid or duplicate tool source id: {id}"),
                ));
            }
        }
        Ok(())
    }

    /// Register an environment with binding-shaped operations.
    pub fn environment_part(&mut self, part: impl crate::EnvironmentPart) -> Result<()> {
        let adapter = crate::environment::Adapter::new(part);
        set_part(
            &mut self.environment,
            Arc::new(adapter.clone()),
            "working-environment",
        )?;
        self.portable_environment = Some(adapter);
        Ok(())
    }

    /// Register an advanced native environment.
    pub fn environment(&mut self, part: impl base::WorkingEnvironment + 'static) -> Result<()> {
        set_part(&mut self.environment, Arc::new(part), "working-environment")
    }
    pub fn runtime(&mut self, part: impl crate::RuntimePart) -> Result<()> {
        if self.runtime.is_some() {
            return Err(Error::new(Code::InvalidComposition, "duplicate runtime"));
        }
        set_part(
            &mut self.portable_runtime,
            crate::runtime::Adapter::new(part)?,
            "runtime",
        )
    }
    /// Advanced native-only Runtime, with direct access to base ports.
    pub fn native_runtime(&mut self, part: impl base::Runtime + 'static) -> Result<()> {
        if self.portable_runtime.is_some() {
            return Err(Error::new(Code::InvalidComposition, "duplicate runtime"));
        }
        set_part(&mut self.runtime, Arc::new(part), "runtime")
    }
    pub fn history_store(&mut self, store: crate::History) -> Result<()> {
        set_part(&mut self.history, store, "history")
    }
    pub fn credential_store(&mut self, store: impl crate::CredentialStore) -> Result<()> {
        set_part(&mut self.credentials, Arc::new(store), "credentials")
    }
    pub fn configuration(&mut self, source: impl crate::Configuration) -> Result<()> {
        set_part(&mut self.configuration, Arc::new(source), "configuration")
    }
    pub fn interface(&mut self, interface: impl crate::Interface) {
        self.interfaces.push(Arc::new(interface));
    }

    pub(crate) fn history_part(&self) -> Option<&crate::History> {
        self.history.as_ref()
    }
    pub(crate) fn has_credentials(&self) -> bool {
        self.credentials.is_some()
    }
    pub(crate) fn has_configuration(&self) -> bool {
        self.configuration.is_some()
    }
    pub(crate) fn has_environment(&self) -> bool {
        self.environment.is_some()
    }

    pub(crate) fn check_servable(&self) -> Result<()> {
        for (registered, name) in [
            (self.runtime.is_some(), "native Runtime"),
            (self.history.is_some(), "history store"),
            (self.credentials.is_some(), "credential store"),
            (self.configuration.is_some(), "configuration"),
            (!self.interfaces.is_empty(), "Interface"),
        ] {
            if registered {
                return Err(cannot_serve(name));
            }
        }
        if let Some(hook) = self.local_hooks.iter().find(|hook| hook.point != "output") {
            return Err(cannot_serve(hook.point));
        }
        if !self.prepare.is_empty() {
            return Err(cannot_serve("local lifecycle or system hook"));
        }
        if let Some(t) = self.tools.iter().find(|t| t.in_process_only) {
            return Err(cannot_serve(&format!("tool:{}", t.name())));
        }
        if let Some(c) = self.commands.iter().find(|c| c.local) {
            return Err(cannot_serve(&format!("command:{}", c.name)));
        }
        if let Some((name, _, _)) = self.defined.first() {
            return Err(cannot_serve(&format!("hook:{name}")));
        }
        if let Some((name, _, _)) = self.subscriptions.first() {
            return Err(cannot_serve(&format!("hook:{name}")));
        }
        Ok(())
    }
}

fn set_part<T>(slot: &mut Option<T>, part: T, name: &str) -> Result<()> {
    if slot.is_some() {
        return Err(Error::new(
            Code::InvalidComposition,
            format!("duplicate {name} registration"),
        ));
    }
    *slot = Some(part);
    Ok(())
}

pub(crate) fn cannot_serve(item: &str) -> Error {
    Error::new(Code::NotSupported, format!("{item} is in-process only"))
}

pub(crate) struct InProcess {
    pub name: String,
    pub registered: Registrar,
    stop: Option<Stop>,
}

impl InProcess {
    pub fn new(plugin: &Plugin) -> Result<Self> {
        Ok(InProcess {
            name: plugin.name.clone(),
            stop: plugin.stop.clone(),
            registered: plugin.register(&plugin.config).map_err(|e| {
                Error::new(
                    Code::InvalidComposition,
                    format!("plugin {} setup failed: {e}", plugin.name),
                )
            })?,
        })
    }
}

impl base::Plugin for InProcess {
    fn name(&self) -> &str {
        &self.name
    }
    fn shutdown(&self) -> BoxFuture<'_, base::Result<()>> {
        Box::pin(async {
            if let Some(stop) = &self.stop {
                stop().await?;
            }
            Ok(())
        })
    }

    fn install(&self, r: &mut base::Registrar<'_>) -> base::Result<()> {
        if let Some(part) = &self.registered.environment {
            r.provide::<dyn base::WorkingEnvironment>("environment", part.clone())?;
        }
        if let Some(part) = &self.registered.runtime {
            base::Plugin::install(&crate::parts::RuntimeAdapter(part.clone()), r)?;
        }
        if let Some(part) = &self.registered.portable_runtime {
            let runtime = plugin_stdio::local_runtime(
                Arc::new(part.clone()),
                part.registration.clone(),
                r.runtime_points(),
            );
            r.provide::<dyn base::Runtime>("runtime", runtime)?;
        }
        if let Some(part) = &self.registered.history {
            r.provide_over_default::<dyn base::HistoryStore>(
                "history",
                "sdk.core",
                part.0.clone(),
            )?;
            r.provide::<crate::History>("sdk.history.part", Arc::new(part.clone()))?;
        }
        if let Some(part) = &self.registered.configuration {
            r.provide_over_default::<dyn base::Configuration>(
                "configuration",
                "sdk.core",
                Arc::new(crate::parts::ConfigurationAdapter(part.clone())),
            )?;
        }
        if let Some(part) = &self.registered.credentials {
            r.provide_over_default::<dyn base::CredentialStore>(
                "credentials",
                "sdk.core",
                Arc::new(crate::credentials::StoreAdapter(part.clone())),
            )?;
        }
        for provider in &self.registered.providers {
            base::Plugin::install(
                &crate::provider::ProviderPlugin {
                    name: format!("provider.{}", provider.id()),
                    provider: provider.clone(),
                },
                r,
            )?;
        }
        let jobs = self
            .registered
            .jobs
            .clone()
            .map(|jobs| (self.name.clone(), jobs));
        if let Some((name, owner)) = jobs.clone() {
            r.provide::<dyn base::ExternalJobs>(
                &format!("external.jobs.sdk.{name}"),
                Arc::new(crate::jobs::LocalOwner(name.clone(), owner.clone())),
            )?;
            let closer = owner.clone();
            r.on(
                "session.end",
                base::Order::First,
                base::handler(move |api, scope, _| {
                    let (name, owner) = (name.clone(), closer.clone());
                    Box::pin(async move {
                        let backend = Backend::Local {
                            api: api.clone(),
                            scope: scope.clone(),
                        };
                        let closer = crate::jobs::LocalOwner(name.clone(), owner.clone());
                        for job in owner
                            .unfinished(&backend, &name, &scope.session)
                            .await?
                            .into_iter()
                            .filter(|j| !j.cleanup_unconfirmed)
                        {
                            if let Err(error) = closer
                                .cancel_record(api.clone(), &job.id, &scope.session)
                                .await
                            {
                                eprintln!("could not cancel job {}: {error}", job.id);
                            }
                        }
                        Ok(base::HookResult::default())
                    })
                }),
            );
            if owner.can_resume()
                && !self
                    .registered
                    .hooks
                    .iter()
                    .any(|hook| hook.point == "session.start")
            {
                let name = self.name.clone();
                r.on(
                    "session.start",
                    base::Order::Normal,
                    base::handler(move |api, scope, _| {
                        let (name, owner) = (name.clone(), owner.clone());
                        Box::pin(async move {
                            let backend = Backend::Local {
                                api,
                                scope: scope.clone(),
                            };
                            for job in owner
                                .unfinished(&backend, &name, &scope.session)
                                .await?
                                .into_iter()
                                .filter(|j| !j.cleanup_unconfirmed)
                            {
                                owner.resume(job).await?;
                            }
                            Ok(base::HookResult::default())
                        })
                    }),
                );
            }
        }
        if !self.registered.tools.is_empty() {
            r.provide::<dyn base::ToolSource>(
                &format!("tools.{}", self.name),
                Arc::new(Source(
                    Arc::new(StaticTools(self.registered.tools.clone())),
                    jobs.clone(),
                )),
            )?;
        }
        for (name, source) in &self.registered.sources {
            source.catalog_notifier(ToolsChanged(Arc::new(|| {})));
            r.provide::<dyn base::ToolSource>(
                &format!("tools.{name}"),
                Arc::new(Source(source.clone(), jobs.clone())),
            )?;
        }
        for prepare in &self.registered.prepare {
            let prepare = prepare.clone();
            r.on(
                "session.prepare",
                base::Order::Normal,
                base::handler(move |api, scope, _| {
                    let prepare = prepare.clone();
                    Box::pin(async move {
                        let project = api.snapshot(&scope.session)?.project;
                        prepare(SessionPrepare {
                            session_id: scope.session,
                            project,
                        })
                        .await?;
                        Ok(base::HookResult::default())
                    })
                }),
            );
        }
        for (name, rule, hook) in &self.registered.defined {
            let point = r.define(name, rule.native())?;
            base::ensure!(hook.0.set(point).is_ok(), "custom hook already registered");
        }
        for (name, order, handle) in &self.registered.subscriptions {
            let handle = handle.clone();
            r.on(
                name,
                order.native(),
                base::handler(move |api, scope, value| {
                    let handle = handle.clone();
                    Box::pin(async move {
                        let context = crate::HookContext::local(api, scope);
                        let _guard = context.settled.clone().drop_guard();
                        Ok(handle(value, context).await?)
                    })
                }),
            );
        }
        for hook in &self.registered.local_hooks {
            let handle = hook.handle.clone();
            let point = hook.point;
            r.on(
                point,
                hook.order.native(),
                base::handler(move |api, scope, mut value| {
                    if point == "output" {
                        value["sessionId"] = json!(scope.session);
                    }
                    let handle = handle.clone();
                    Box::pin(async move {
                        let context = crate::HookContext::local(api, scope);
                        let _guard = context.settled.clone().drop_guard();
                        Ok(handle(value, context).await?)
                    })
                }),
            );
        }
        for (index, hook) in self.registered.hooks.iter().enumerate() {
            let handle = hook.handle.clone();
            let point = hook.point;
            let question_key = format!("gate:{}:{index}", self.name);
            let job_owner = (point == "session.start").then(|| jobs.clone()).flatten();
            r.on(
                plugin_stdio::hook_name(point).expect("known hook"),
                hook.order.native(),
                base::handler(move |api, scope, original| {
                    let handle = handle.clone();
                    let question_key = question_key.clone();
                    let job_owner = job_owner.clone();
                    Box::pin(async move {
                        let mut payload =
                            plugin_stdio::hook_payload(point, &scope, &original, &api)?;
                        if point == "step.before" {
                            let data = api.snapshot(&scope.session)?;
                            payload["history"] = json!(
                                data.entries
                                    .iter()
                                    .filter(|e| e.writer != "rust.derived")
                                    .map(|e| base::wire::entry(e, &data))
                                    .collect::<base::Result<Vec<_>>>()?
                            );
                            let usage: base::Usage =
                                serde_json::from_value(original["usage"].clone())?;
                            payload["usage"] = json!(crate::Usage::from(usage));
                        }
                        if point == "turn.before" {
                            let data = api.snapshot(&scope.session)?;
                            payload["project"] = json!(data.project);
                            payload["tools"] = json!(
                                base::nested_tool_definitions(api.as_ref(), &data)?
                                    .iter()
                                    .map(base::wire::definition)
                                    .collect::<Vec<_>>()
                            );
                        }
                        let mut context = crate::HookContext::local(api.clone(), scope.clone());
                        context.job_owner = job_owner;
                        let guard = context.settled.clone().drop_guard();
                        let reply = handle(payload, context)
                            .await
                            .map_err(|e| base::anyhow!("{}", e.message()))?;
                        drop(guard);
                        if point == "tool.before"
                            && let Some(ask) = reply.get("pendingQuestion")
                        {
                            let ask: crate::Ask = serde_json::from_value(ask.clone())?;
                            let mut question = ask.into_question(scope.clone());
                            question.key = scope
                                .call
                                .as_ref()
                                .map(|call| format!("{question_key}:{call}"));
                            question.timeout_ms = Some(0);
                            if question.kind == base::RequestKind::Approval {
                                question.extra["approvalCall"] = plugin_stdio::hook_payload(
                                    point, &scope, &original, &api,
                                )?["call"]
                                    .clone();
                            }
                            let cancelled = api.cancellation(&scope.session)?;
                            return Ok(
                                match base::requests(api.as_ref())?
                                    .ask(api, question, cancelled)
                                    .await?
                                {
                                    base::RequestReply::Waiting => base::HookResult {
                                        suspended: true,
                                        ..Default::default()
                                    },
                                    base::RequestReply::Answer(answer) if !answer.declined => {
                                        base::HookResult::default()
                                    }
                                    _ => base::HookResult {
                                        refused: Some("question declined".into()),
                                        ..Default::default()
                                    },
                                },
                            );
                        }
                        if point == "input"
                            && let Some(line) = reply["command"].as_str()
                        {
                            let (name, args) = command_line(line);
                            let value = api.command(&scope, name, args).await?;
                            return Ok(base::HookResult {
                                stopped: true,
                                ..base::answer(value)
                            });
                        }
                        plugin_stdio::hook_result(point, &scope, original, reply)
                    })
                }),
            );
        }
        for command in &self.registered.commands {
            let run = command.run.clone();
            let uses_model = command.uses_model;
            let can_ask = command.local;
            let jobs = jobs.clone();
            r.command(
                &command.name,
                base::handler(move |api, scope, args| {
                    let run = run.clone();
                    let jobs = jobs.clone();
                    Box::pin(async move {
                        let cancelled = api.cancellation(&scope.session)?;
                        let done = cancelled.child_token();
                        let _guard = done.clone().drop_guard();
                        let work_scope = base::Scope {
                            step: Some(base::id()),
                            turn: None,
                            ..scope.clone()
                        };
                        let model = uses_model.then(|| {
                            Arc::new(CommandModel {
                                api: api.clone(),
                                scope: work_scope.clone(),
                                done: done.clone(),
                                sequence: tokio::sync::Mutex::new(()),
                            })
                        });
                        let work = ToolContext {
                            jobs,
                            backend: Backend::Local {
                                api: api.clone(),
                                scope: work_scope,
                            },
                            session_id: scope.session.clone(),
                            actor_id: scope.actor.clone(),
                            project: api.snapshot(&scope.session)?.project,
                            call_id: String::new(),
                            parent_call_id: None,
                            turn_id: None,
                            step_id: scope.step.clone(),
                            cancelled: cancelled.clone(),
                            settled: done,
                            asks: Default::default(),
                        };
                        let text = run(
                            args["args"].as_str().unwrap_or_default().into(),
                            CommandContext {
                                session_id: scope.session,
                                actor_id: scope.actor,
                                cancelled,
                                model,
                                work,
                                can_ask,
                            },
                        )
                        .await?;
                        Ok(base::answer(command_reply(text)))
                    })
                }),
            )?;
        }
        Ok(())
    }
}

pub(crate) fn command_line(line: &str) -> (&str, &str) {
    let line = line.trim_start().trim_start_matches('/');
    line.split_once(char::is_whitespace).unwrap_or((line, ""))
}

async fn request_from_command(
    context: &CommandModel,
    input: crate::ModelRequest,
    cancelled: CancellationToken,
) -> Result<crate::AssistantMessage> {
    let (api, scope) = (&context.api, &context.scope);
    base::require(api.as_ref(), scope, "input")?;
    let select: Arc<dyn base::ModelSelection> = base::capability(api.as_ref(), "model.selection")?;
    let model = select.select(api.clone(), scope).await?;
    model.refresh(api, scope, cancelled.clone()).await?;
    let info = model.info();
    if info.runs_tools {
        return Err(Error::new(
            Code::NotSupported,
            "auxiliary requests cannot authorize Provider tools",
        ));
    }
    let data = api.snapshot(&scope.session)?;
    let mut request = base::wire::parse_request(&input.0, &scope.session)
        .map_err(|e| Error::new(Code::InvalidRequest, e.to_string()))?;
    request.output_limit = input.0["settings"]["maxOutput"]
        .as_u64()
        .or_else(|| data.settings["output_limit"].as_u64())
        .unwrap_or(info.output_limit)
        .min(info.output_limit);
    request.thinking = base::wire::lower_reasoning(
        input.0["settings"]["reasoning"]
            .as_str()
            .or_else(|| data.settings["thinking"].as_str())
            .unwrap_or(""),
        &info.thinking,
    )
    .into();
    base::refresh_tool_sources(api, scope).await?;
    let tools = base::current_model_tools(api, scope, &request.tools)?;
    request = serde_json::from_value(
        api.output(
            scope,
            base::Output {
                recipient: "model".into(),
                value: json!(request),
                stream: None,
                end: true,
            },
        )
        .await?
        .ok_or_else(|| Error::new(Code::Withheld, "auxiliary request blocked"))?,
    )
    .map_err(|e| Error::new(Code::InvalidRequest, e.to_string()))?;
    let known: std::collections::BTreeSet<_> = data.entries.iter().map(|entry| &entry.id).collect();
    let generated = model
        .generate_attempt(
            api.clone(),
            scope.clone(),
            request,
            cancelled,
            base::ModelAttempt {
                writer: "sdk.command",
                tools,
                sources: known.iter().map(|id| (*id).clone()).collect(),
                auxiliary: true,
                safe_to_repeat: false,
                replay: None,
                close_attempt: None,
                authorized_wire: None,
            },
        )
        .await;
    let intent = api
        .snapshot(&scope.session)?
        .entries
        .into_iter()
        .rev()
        .find(|e| {
            e.kind == "model.request" && e.scope.step == scope.step && !known.contains(&e.id)
        });
    let response = match generated {
        Ok(response) => response,
        Err(e) if intent.is_some() && e.downcast_ref::<base::ModelAttemptLimit>().is_none() => {
            let failure = e
                .downcast_ref::<base::ModelFailure>()
                .map(base::wire::failure)
                .unwrap_or_else(|| json!({"kind":"other","message":e.to_string()}));
            base::wire::parse_response(
                json!({"role":"assistant","content":[],"stop":"failed","error":failure}),
            )?
        }
        Err(e) => return Err(e.into()),
    };
    let intent =
        intent.ok_or_else(|| Error::new(Code::Internal, "missing auxiliary model request"))?;
    api.append(
        scope,
        "sdk.command",
        base::Draft::new("model.response", false, json!(response)).copying(vec![intent.id]),
    )?;
    Ok(crate::AssistantMessage(base::wire::response(&response)))
}

pub(crate) fn command_reply(text: Option<String>) -> Value {
    match text {
        Some(text) => json!({"content":[{"type":"text","text":text}]}),
        None => json!({}),
    }
}

struct StaticTools(Vec<Tool>);
impl ToolSource for StaticTools {
    fn tools(&self, _: &str) -> Vec<Tool> {
        self.0.clone()
    }
}

struct Source(Arc<dyn ToolSource>, Option<(String, crate::jobs::Owner)>);

#[async_trait::async_trait]
impl base::ToolSource for Source {
    fn tools(&self, session: &base::SessionData) -> Vec<base::ToolDefinition> {
        self.0
            .tools(if self.0.per_session() {
                &session.id
            } else {
                ""
            })
            .into_iter()
            .map(|t| t.definition)
            .collect()
    }
    async fn run(
        &self,
        api: base::Api,
        scope: base::Scope,
        call: base::ToolCall,
        cancel: base::CancellationToken,
    ) -> base::ToolResult {
        let Some(tool) = self
            .0
            .tools(if self.0.per_session() {
                &scope.session
            } else {
                ""
            })
            .into_iter()
            .find(|t| t.definition.name == call.name)
        else {
            return base::ToolResult::new(
                &call,
                base::ToolStatus::Failed,
                format!("no tool named {}", call.name),
            );
        };
        let project = match api.snapshot(&scope.session) {
            Ok(data) => data.project,
            Err(e) => return base::ToolResult::new(&call, base::ToolStatus::Failed, e.to_string()),
        };
        let cx = ToolContext {
            jobs: self.1.clone(),
            project,
            session_id: scope.session.clone(),
            actor_id: scope.actor.clone(),
            call_id: call.id.clone(),
            parent_call_id: call.extra["parentCallId"].as_str().map(str::to_owned),
            turn_id: scope.turn.clone(),
            step_id: scope.step.clone(),
            backend: Backend::Local { api, scope },
            cancelled: cancel,
            settled: Default::default(),
            asks: Default::default(),
        };
        let Some(settled) = execute(&tool, call.input.clone(), cx).await else {
            return base::ToolResult::new(&call, base::ToolStatus::Waiting, "question left open");
        };
        // ToolResult::new words a refusal itself.
        let mut result = base::ToolResult::new(&call, settled.status.to_base(), settled.text);
        // Preserve the distinction between an omitted value and JSON null, and
        // keep developer-owned objects opaque even if they contain `_pluginWire`.
        result.value = settled
            .value
            .map(|value| json!({"_pluginWire":{"value":value}}));
        match settled.content {
            Some(content) => result.with_content(content),
            None => result,
        }
    }
}
