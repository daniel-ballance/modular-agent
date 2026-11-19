//! Plugins: a named bundle of tools and hooks (docs/sdk/api.md#plugins).
//!
//! Everything a plugin can register here can cross the plugin binding, so every plugin
//! built with this API is servable.
use crate::{
    error::Result,
    tool::{Backend, Tool, ToolContext, execute},
};
use agent_api as base;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::{future::Future, sync::Arc};

type Setup = Arc<dyn Fn(&mut Registrar) -> Result<()> + Send + Sync>;
pub(crate) type ToolBeforeHandler =
    Arc<dyn Fn(ToolBefore) -> BoxFuture<'static, Result<Gate>> + Send + Sync>;

/// A named bundle of tools and hooks, added to an agent or served in its own process.
#[derive(Clone)]
pub struct Plugin {
    pub(crate) name: String,
    pub(crate) replaces: Vec<String>,
    pub(crate) config: Value,
    setups: Vec<Setup>,
}

/// What a plugin registers, once, when it is loaded.
pub struct Registrar {
    config: Value,
    pub(crate) tools: Vec<Tool>,
    pub(crate) tool_before: Vec<ToolBeforeHandler>,
}

/// The payload of `tool.before`: the call about to run.
#[derive(Clone, Debug)]
pub struct ToolBefore {
    pub session_id: String,
    pub call_id: String,
    pub name: String,
    pub input: Value,
}

/// A gate's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Gate {
    Allow,
    Refuse(String),
}

impl Plugin {
    /// A plugin with a name that is unique in the agent and stable, because history
    /// records it.
    pub fn new(name: impl Into<String>) -> Self {
        Plugin {
            name: name.into(),
            replaces: vec![],
            config: json!({}),
            setups: vec![],
        }
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    /// An item of this plugin that replaces an earlier plugin's: `runtime`,
    /// `working-environment`, `provider:<id>`, `tool:<name>` or `command:<name>`.
    pub fn replaces(mut self, item: impl Into<String>) -> Self {
        self.replaces.push(item.into());
        self
    }
    /// The plugin's settings when it runs in the agent's process. A served plugin gets
    /// its settings from the agent that loads it instead.
    pub fn config(mut self, config: Value) -> Self {
        self.config = config;
        self
    }
    pub fn tool(self, tool: Tool) -> Self {
        self.setup(move |r| {
            r.tool(tool.clone());
            Ok(())
        })
    }
    pub fn on_tool_before<F, Fut>(self, handler: F) -> Self
    where
        F: Fn(ToolBefore) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Gate>> + Send + 'static,
    {
        let handler: ToolBeforeHandler = Arc::new(move |b| Box::pin(handler(b)));
        self.setup(move |r| {
            r.tool_before.push(handler.clone());
            Ok(())
        })
    }
    /// Register items that depend on the plugin's settings.
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
            tool_before: vec![],
        };
        for setup in &self.setups {
            setup(&mut r)?;
        }
        Ok(r)
    }
}

impl Registrar {
    /// The plugin's settings, `{}` if none.
    pub fn config(&self) -> &Value {
        &self.config
    }
    pub fn tool(&mut self, tool: Tool) {
        self.tools.push(tool);
    }
    pub fn on_tool_before<F, Fut>(&mut self, handler: F)
    where
        F: Fn(ToolBefore) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Gate>> + Send + 'static,
    {
        self.tool_before
            .push(Arc::new(move |b| Box::pin(handler(b))));
    }
}

/// A plugin in the agent's process, as one of the base's plugins.
pub(crate) struct InProcess {
    pub name: String,
    pub registered: Registrar,
}

impl InProcess {
    pub fn new(plugin: &Plugin) -> Result<Self> {
        Ok(InProcess {
            name: plugin.name.clone(),
            registered: plugin.register(&plugin.config)?,
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
        for handler in &self.registered.tool_before {
            let handler = handler.clone();
            r.on(
                "runtime.before.tool",
                base::Order::Normal,
                base::handler(move |_, scope, value| {
                    let handler = handler.clone();
                    Box::pin(async move {
                        let before = ToolBefore {
                            session_id: scope.session.clone(),
                            call_id: value["call"]["id"].as_str().unwrap_or_default().into(),
                            name: value["call"]["name"].as_str().unwrap_or_default().into(),
                            input: value["call"]["input"].clone(),
                        };
                        // A failed gate is a refusal (contracts.md#hook-execution).
                        let refusal = match handler(before).await {
                            Ok(Gate::Allow) => None,
                            Ok(Gate::Refuse(reason)) => Some(reason),
                            Err(e) => {
                                Some(format!("a tool.before handler failed: {}", e.message()))
                            }
                        };
                        Ok(match refusal {
                            None => base::answer(value),
                            Some(reason) => base::HookResult {
                                refused: Some(reason),
                                ..Default::default()
                            },
                        })
                    })
                }),
            );
        }
        Ok(())
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
        };
        let settled = execute(tool, call.input.clone(), cx).await;
        // ToolResult::new words a refusal itself.
        let mut result = base::ToolResult::new(&call, settled.status.to_base(), settled.text);
        result.value = settled.value;
        result
    }
}
