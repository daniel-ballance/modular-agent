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

type Setup = Arc<dyn Fn(&mut Registrar) -> Result<()> + Send + Sync>;
type CommandHandler =
    Arc<dyn Fn(String, CommandContext) -> BoxFuture<'static, Result<Option<String>>> + Send + Sync>;

/// A named bundle of parts, added to an agent or served over the plugin binding.
#[derive(Clone)]
pub struct Plugin {
    pub(crate) name: String,
    pub(crate) replaces: Vec<String>,
    pub(crate) config: Value,
    pub(crate) local_items: Vec<String>,
    setups: Vec<Setup>,
}

/// What a plugin registers, once, when it is loaded.
pub struct Registrar {
    config: Value,
    pub(crate) tools: Vec<Tool>,
    pub(crate) hooks: Vec<Hook>,
    pub(crate) commands: Vec<Command>,
    defined: Vec<(String, HookRule)>,
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
    pub fn setup<F>(mut self, setup: F) -> Self
    where
        F: Fn(&mut Registrar) -> Result<()> + Send + Sync + 'static,
    {
        self.setups.push(Arc::new(setup));
        self
    }
    pub(crate) fn register(&self, config: &Value) -> Result<Registrar> {
        let mut r = Registrar {
            config: config.clone(),
            tools: vec![],
            hooks: vec![],
            commands: vec![],
            defined: vec![],
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
    pub fn command(&mut self, command: Command) {
        self.commands.push(command);
    }
    pub fn define_hook(&mut self, name: impl Into<String>, rule: HookRule) {
        self.defined.push((name.into(), rule));
    }
    pub(crate) fn check_servable(&self) -> Result<()> {
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
}

impl InProcess {
    pub fn new(plugin: &Plugin) -> Result<Self> {
        Ok(InProcess {
            name: plugin.name.clone(),
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
    fn install(&self, r: &mut base::Registrar<'_>) -> base::Result<()> {
        if !self.registered.tools.is_empty() {
            r.provide::<dyn base::ToolSource>(
                &format!("tools.{}", self.name),
                Arc::new(Source(self.registered.tools.clone())),
            )?;
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
                        let payload = plugin_stdio::hook_payload(point, &scope, &original, &api)?;
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

struct Source(Vec<Tool>);

#[async_trait::async_trait]
impl base::ToolSource for Source {
    fn tools(&self, _: &base::SessionData) -> Vec<base::ToolDefinition> {
        self.0.iter().map(|t| t.definition.clone()).collect()
    }
    async fn run(
        &self,
        api: base::Api,
        scope: base::Scope,
        call: base::ToolCall,
        cancel: base::CancellationToken,
    ) -> base::ToolResult {
        let Some(tool) = self.0.iter().find(|t| t.definition.name == call.name) else {
            return base::ToolResult::new(
                &call,
                base::ToolStatus::Failed,
                format!("no tool named {}", call.name),
            );
        };
        let cx = ToolContext {
            session_id: scope.session.clone(),
            actor_id: scope.actor.clone(),
            call_id: call.id.clone(),
            backend: Backend::Local { api, scope },
            cancelled: cancel,
            settled: Default::default(),
        };
        let settled = execute(tool, call.input.clone(), cx).await;
        // ToolResult::new words a refusal itself.
        let mut result = base::ToolResult::new(&call, settled.status.to_base(), settled.text);
        result.value = settled.value;
        result
    }
}
