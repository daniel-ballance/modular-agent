use crate::*;
use std::{any::Any, collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    Observe,
    Gate,
    Transform,
    FirstAnswer,
    Collect,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum Order {
    First,
    #[default]
    Normal,
    Last,
}
/// An unforgeable invocation token, issued only when its owner defines the point.
#[derive(Clone, Debug)]
pub struct HookPoint {
    pub name: String,
    owner: String,
    nonce: String,
}
#[async_trait]
pub trait Handler: Send + Sync {
    async fn handle(&self, api: Api, scope: Scope, value: Value) -> Result<HookResult>;
}
pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<HookResult>> + Send>>;
struct FunctionHandler<F>(F);
#[async_trait]
impl<F> Handler for FunctionHandler<F>
where
    F: Fn(Api, Scope, Value) -> HandlerFuture + Send + Sync,
{
    async fn handle(&self, api: Api, scope: Scope, value: Value) -> Result<HookResult> {
        (self.0)(api, scope, value).await
    }
}
pub fn handler<F>(f: F) -> Arc<dyn Handler>
where
    F: Fn(Api, Scope, Value) -> HandlerFuture + Send + Sync + 'static,
{
    Arc::new(FunctionHandler(f))
}
pub fn answer(value: Value) -> HookResult {
    HookResult {
        value,
        answered: true,
        ..HookResult::default()
    }
}
#[derive(Clone)]
struct Owned<T> {
    owner: String,
    value: T,
}
#[derive(Clone)]
pub struct HookDefinition {
    pub point: HookPoint,
    pub rule: Rule,
}
#[derive(Clone)]
struct Registration {
    owner: String,
    order: Order,
    handler: Arc<dyn Handler>,
}
#[derive(Clone, Default)]
pub struct Registry {
    plugins: Vec<String>,
    capabilities: BTreeMap<String, Owned<Arc<dyn Any + Send + Sync>>>,
    hooks: BTreeMap<String, HookDefinition>,
    handlers: BTreeMap<String, Vec<Registration>>,
    commands: BTreeMap<String, Owned<Arc<dyn Handler>>>,
    declarations: BTreeMap<String, Value>,
    /// Credential name to the plugin that claimed it.
    credentials: BTreeMap<String, String>,
}
/// Proof that a plugin registered a credential name as its own. Only the
/// Registrar makes one, at install, so a plugin cannot make a claim for a
/// name another plugin holds. A credential store gives a Provider's
/// credential only against the claim.
#[derive(Clone, Debug)]
pub struct CredentialClaim {
    owner: String,
    names: Vec<String>,
}
impl CredentialClaim {
    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn covers(&self, name: &str) -> bool {
        self.names.iter().any(|n| n == name)
    }
}
pub trait Plugin: Send + Sync {
    fn name(&self) -> &str;
    fn registered_name(&self) -> &str {
        self.name()
    }
    fn replaces(&self) -> Option<&str> {
        None
    }
    fn install(&self, registrar: &mut Registrar<'_>) -> Result<()>;
    fn stop(&self) -> Result<()> {
        Ok(())
    }
    fn shutdown(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async { self.stop() })
    }
}
pub struct Registrar<'a> {
    registry: &'a mut Registry,
    owner: String,
}
impl Registry {
    pub fn with_harness_hooks() -> (Self, BTreeMap<String, HookPoint>) {
        let mut registry = Self::default();
        let mut points = BTreeMap::new();
        let mut r = Registrar {
            registry: &mut registry,
            owner: "harness".into(),
        };
        for (name, rule) in [
            ("plugin.load", Rule::Gate),
            ("session.prepare", Rule::Observe),
            ("session.start", Rule::Observe),
            ("session.end", Rule::Observe),
            ("input", Rule::Transform),
            ("before.turn", Rule::Collect),
            ("provider.request", Rule::Transform),
            ("provider.response", Rule::Observe),
            ("output", Rule::Transform),
            ("output.stream", Rule::Transform),
        ] {
            points.insert(
                name.into(),
                r.define(name, rule).expect("unique builtin hook"),
            );
        }
        (registry, points)
    }
    pub fn load(&mut self, plugin: &dyn Plugin) -> Result<()> {
        let mut next = self.clone();
        if let Some(old) = plugin.replaces() {
            ensure!(
                next.plugins.iter().any(|p| p == old),
                "replacement target {old} is not loaded"
            );
            next.plugins.retain(|p| p != old);
            next.capabilities.retain(|_, v| v.owner != old);
            next.commands.retain(|_, v| v.owner != old);
            next.credentials.retain(|_, owner| owner != old);
            next.declarations.remove(old);
            next.hooks.retain(|_, v| v.point.owner != old);
            for handlers in next.handlers.values_mut() {
                handlers.retain(|h| h.owner != old);
            }
        }
        ensure!(
            !next.plugins.iter().any(|p| p == plugin.name()),
            "duplicate plugin {}",
            plugin.name()
        );
        plugin.install(&mut Registrar {
            registry: &mut next,
            owner: plugin.name().into(),
        })?;
        next.plugins.push(plugin.name().into());
        *self = next;
        Ok(())
    }
    /// Item-level wire replacements affect only local registrations, atomically.
    pub fn omit_local(&mut self, items: &[String], session: &SessionData) -> Result<()> {
        for item in items {
            if item == "runtime" {
                for key in ["runtime", "runtime.transient", "runtime.durable"] {
                    if let Some(old) = self.capabilities.get(key) {
                        ensure!(
                            !old.owner.starts_with("external."),
                            "cannot replace an external Runtime"
                        );
                        self.capabilities.remove(key);
                    }
                }
            } else if item == "working-environment" {
                if let Some(old) = self.capabilities.get("environment") {
                    ensure!(
                        !old.owner.starts_with("external."),
                        "cannot replace an external environment"
                    );
                    self.capabilities.remove("environment");
                }
            } else if let Some(id) = item.strip_prefix("provider:") {
                let key = format!("provider.{id}");
                if let Some(old) = self.capabilities.get(&key) {
                    ensure!(
                        !old.owner.starts_with("external."),
                        "cannot replace external provider {id}"
                    );
                    self.capabilities.remove(&key);
                }
            } else if let Some(name) = item.strip_prefix("command:") {
                if let Some(old) = self.commands.get(name) {
                    ensure!(
                        !old.owner.starts_with("external."),
                        "cannot replace external command {name}"
                    );
                    self.commands.remove(name);
                }
            } else if let Some(name) = item.strip_prefix("tool:") {
                for key in self.capability_names("tools.") {
                    let owned = &self.capabilities[&key];
                    let source = owned
                        .value
                        .downcast_ref::<Capability<dyn ToolSource>>()
                        .ok_or_else(|| anyhow!("wrong tool-source capability"))?
                        .0
                        .clone();
                    if source.tools(session).iter().any(|t| t.name == name) {
                        ensure!(
                            !owned.owner.starts_with("external."),
                            "cannot replace external tool {name}"
                        );
                        let filtered: Arc<dyn ToolSource> = Arc::new(FilteredSource {
                            inner: source,
                            excluded: name.into(),
                        });
                        self.capabilities.get_mut(&key).unwrap().value =
                            Arc::new(Capability(filtered));
                    }
                }
            } else {
                bail!("unknown replacement {item}");
            }
        }
        Ok(())
    }
    pub fn tool_registration(&self, key: &str) -> Value {
        let owner = self
            .capabilities
            .get(key)
            .map(|entry| entry.owner.as_str())
            .unwrap_or(key);
        let plugin = owner
            .strip_prefix("external.")
            .and_then(|rest| rest.split_once('.'))
            .map_or(owner, |(_, name)| name);
        let tool = key.strip_prefix("tools.").unwrap_or(key);
        let tool = tool
            .strip_prefix(owner)
            .and_then(|rest| rest.strip_prefix('.'))
            .unwrap_or(tool);
        json!({"plugin":plugin,"toolSource":tool})
    }
    pub fn validate_tools(&self, session: &SessionData) -> Result<()> {
        let mut names = std::collections::BTreeSet::new();
        for key in self.capability_names("tools.") {
            let source = self.capabilities[&key]
                .value
                .downcast_ref::<Capability<dyn ToolSource>>()
                .ok_or_else(|| anyhow!("wrong tool-source capability"))?;
            for tool in source.0.tools(session) {
                ensure!(
                    names.insert(tool.name.clone()),
                    "duplicate tool {}",
                    tool.name
                );
            }
        }
        Ok(())
    }
    pub fn declaration(&self) -> Value {
        let mut result = json!({});
        for name in &self.plugins {
            if let Some(value) = self.declarations.get(name) {
                merge(&mut result, value.clone());
            }
        }
        result["hook_points"]=json!(self.hooks.values().map(|h|json!({"name":h.point.name,"owner":h.point.owner,"rule":format!("{:?}",h.rule)})).collect::<Vec<_>>());
        result
    }
    pub fn names(&self) -> Vec<String> {
        self.plugins.clone()
    }
    pub fn capability(&self, name: &str) -> Result<Arc<dyn Any + Send + Sync>> {
        Ok(self
            .capabilities
            .get(name)
            .ok_or_else(|| anyhow!("missing capability {name}"))?
            .value
            .clone())
    }
    pub fn capability_names(&self, prefix: &str) -> Vec<String> {
        self.capabilities
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect()
    }
    pub fn command(&self, name: &str) -> Result<Arc<dyn Handler>> {
        Ok(self
            .commands
            .get(name)
            .ok_or_else(|| anyhow!("unknown command /{name}"))?
            .value
            .clone())
    }
    pub fn commands(&self) -> Vec<String> {
        self.commands.keys().cloned().collect()
    }
    pub fn runtime_points(&self) -> BTreeMap<String, HookPoint> {
        self.hooks
            .iter()
            .filter(|(name, _)| name.starts_with("runtime."))
            .map(|(name, def)| (name.clone(), def.point.clone()))
            .collect()
    }
    pub fn definition(&self, point: &HookPoint) -> Result<HookDefinition> {
        let d = self
            .hooks
            .get(&point.name)
            .ok_or_else(|| anyhow!("unknown hook {}", point.name))?;
        ensure!(
            d.point.nonce == point.nonce && d.point.owner == point.owner,
            "hook owner mismatch"
        );
        Ok(d.clone())
    }
    pub async fn invoke(
        &self,
        api: Api,
        point: &HookPoint,
        scope: &Scope,
        mut value: Value,
    ) -> Result<HookResult> {
        let rule = self.definition(point)?.rule;
        let mut handlers = self.handlers.get(&point.name).cloned().unwrap_or_default();
        handlers.sort_by_key(|h| h.order);
        let mut collected = vec![];
        let mut answered = false;
        for h in handlers {
            let result = h
                .handler
                .handle(api.clone(), scope.clone(), value.clone())
                .await;
            let reply = match result {
                Ok(r) => r,
                Err(e) if rule == Rule::Gate => {
                    return Ok(HookResult {
                        refused: Some(e.to_string()),
                        stopped: true,
                        ..answer(value)
                    });
                }
                Err(e) => return Err(e),
            };
            match rule {
                Rule::Observe => (),
                Rule::Gate => {
                    if reply.refused.is_some() || reply.suspended {
                        return Ok(reply);
                    }
                    if reply.answered {
                        value = reply.value;
                        answered = true;
                    }
                }
                Rule::Transform => {
                    if reply.answered {
                        value = reply.value;
                        answered = true;
                    }
                    if reply.stopped {
                        return Ok(HookResult {
                            value,
                            stopped: true,
                            answered,
                            refused: reply.refused,
                            suspended: reply.suspended,
                        });
                    }
                }
                Rule::FirstAnswer => {
                    if reply.answered {
                        return Ok(reply);
                    }
                }
                Rule::Collect => {
                    if reply.answered {
                        collected.push(reply.value);
                        answered = true;
                    }
                }
            }
        }
        if rule == Rule::Collect {
            value = json!(collected);
        }
        Ok(HookResult {
            value,
            answered,
            ..HookResult::default()
        })
    }
}
impl Registrar<'_> {
    pub fn declare(&mut self, value: Value) {
        self.registry.declarations.insert(self.owner.clone(), value);
    }
    /// Register credential names as this plugin's own. A name another plugin
    /// holds is refused, which stops the load.
    pub fn claim_credentials(&mut self, names: &[&str]) -> Result<CredentialClaim> {
        for name in names {
            if let Some(owner) = self.registry.credentials.get(*name) {
                ensure!(
                    owner == &self.owner,
                    "credential {name} already belongs to {owner}"
                );
            }
        }
        for name in names {
            self.registry
                .credentials
                .insert(name.to_string(), self.owner.clone());
        }
        Ok(CredentialClaim {
            owner: self.owner.clone(),
            names: names.iter().map(|n| n.to_string()).collect(),
        })
    }
    pub fn provide<T: ?Sized + Send + Sync + 'static>(
        &mut self,
        name: &str,
        value: Arc<T>,
    ) -> Result<()> {
        ensure!(
            !self.registry.capabilities.contains_key(name),
            "duplicate capability {name}"
        );
        self.registry.capabilities.insert(
            name.into(),
            Owned {
                owner: self.owner.clone(),
                value: Arc::new(Capability(value)),
            },
        );
        Ok(())
    }
    pub fn define(&mut self, name: &str, rule: Rule) -> Result<HookPoint> {
        ensure!(
            !self.registry.hooks.contains_key(name),
            "duplicate hook {name}"
        );
        let point = HookPoint {
            name: name.into(),
            owner: self.owner.clone(),
            nonce: id(),
        };
        self.registry.hooks.insert(
            name.into(),
            HookDefinition {
                point: point.clone(),
                rule,
            },
        );
        Ok(point)
    }
    pub fn on(&mut self, name: &str, order: Order, handler: Arc<dyn Handler>) {
        self.registry
            .handlers
            .entry(name.into())
            .or_default()
            .push(Registration {
                owner: self.owner.clone(),
                order,
                handler,
            });
    }
    pub fn command(&mut self, name: &str, handler: Arc<dyn Handler>) -> Result<()> {
        ensure!(
            !self.registry.commands.contains_key(name),
            "duplicate command /{name}"
        );
        self.registry.commands.insert(
            name.into(),
            Owned {
                owner: self.owner.clone(),
                value: handler,
            },
        );
        Ok(())
    }
}
