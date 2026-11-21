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
    fn tools(&self, session_id: &str) -> Vec<Tool>;
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
    pub(crate) commands: Vec<Command>,
    defined: Vec<(String, HookRule)>,
    sources: Vec<(String, Arc<dyn ToolSource>)>,
    prepare: Vec<LocalHook<SessionPrepare, ()>>,
}

#[derive(Clone)]
pub struct Command {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) local: bool,
    pub(crate) run: CommandHandler,
}

#[derive(Clone, Debug)]
pub struct CommandContext {
    pub session_id: String,
    pub actor_id: String,
    pub cancelled: CancellationToken,
}
impl CommandContext {
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
            run: Arc::new(move |args, cx| Box::pin(handler(args, cx))),
        }
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
    /// Register a local source whose catalog may vary by session.
    pub fn tool_source(self, name: impl Into<String>, source: impl ToolSource) -> Self {
        let name = name.into();
        let source: Arc<dyn ToolSource> = Arc::new(source);
        self.setup(move |r| {
            r.sources.push((name.clone(), source.clone()));
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
            commands: vec![],
            defined: vec![],
            sources: vec![],
            prepare: vec![],
        };
        for setup in &self.setups {
            setup(&mut r)?;
        }
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
    pub fn define_hook(&mut self, name: impl Into<String>, rule: HookRule) {
        self.defined.push((name.into(), rule));
    }
    pub(crate) fn check_servable(&self) -> Result<()> {
        if !self.sources.is_empty() {
            return Err(cannot_serve("dynamic tool source"));
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
        if let Some((name, _)) = self.defined.first() {
            return Err(cannot_serve(&format!("hook:{name}")));
        }
        Ok(())
    }
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
        for provider in &self.registered.providers {
            base::Plugin::install(
                &crate::provider::ProviderPlugin {
                    name: format!("provider.{}", provider.id()),
                    provider: provider.clone(),
                },
                r,
            )?;
        }
        if !self.registered.tools.is_empty() {
            r.provide::<dyn base::ToolSource>(
                &format!("tools.{}", self.name),
                Arc::new(Source(Arc::new(StaticTools(self.registered.tools.clone())))),
            )?;
        }
        for (name, source) in &self.registered.sources {
            r.provide::<dyn base::ToolSource>(
                &format!("tools.{name}"),
                Arc::new(Source(source.clone())),
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
        for (name, rule) in &self.registered.defined {
            r.define(name, rule.native())?;
        }
        for hook in &self.registered.hooks {
            let handle = hook.handle.clone();
            let point = hook.point;
            r.on(
                plugin_stdio::hook_name(point).expect("known hook"),
                hook.order.native(),
                base::handler(move |api, scope, original| {
                    let handle = handle.clone();
                    Box::pin(async move {
                        let mut payload =
                            plugin_stdio::hook_payload(point, &scope, &original, &api)?;
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
                        let reply = handle(payload)
                            .await
                            .map_err(|e| base::anyhow!("{}", e.message()))?;
                        plugin_stdio::hook_result(point, &scope, original, reply)
                    })
                }),
            );
        }
        for command in &self.registered.commands {
            let run = command.run.clone();
            r.command(
                &command.name,
                base::handler(move |api, scope, args| {
                    let run = run.clone();
                    Box::pin(async move {
                        let cancelled = api.cancellation(&scope.session)?;
                        let text = run(
                            args["args"].as_str().unwrap_or_default().into(),
                            CommandContext {
                                session_id: scope.session,
                                actor_id: scope.actor,
                                cancelled,
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

struct Source(Arc<dyn ToolSource>);

#[async_trait::async_trait]
impl base::ToolSource for Source {
    fn tools(&self, session: &base::SessionData) -> Vec<base::ToolDefinition> {
        self.0
            .tools(&session.id)
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
            .tools(&scope.session)
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
            project,
            session_id: scope.session.clone(),
            actor_id: scope.actor.clone(),
            call_id: call.id.clone(),
            backend: Backend::Local { api, scope },
            cancelled: cancel,
            settled: Default::default(),
        };
        let settled = execute(&tool, call.input.clone(), cx).await;
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
