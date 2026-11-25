//! Composition root. All behavior is supplied by interchangeable plugins.
pub mod acp;
use agent_api::*;
use agent_harness::Harness;
use std::{path::PathBuf, sync::Arc};
#[derive(Clone)]
pub struct Options {
    pub history: PathBuf,
    pub global_config: PathBuf,
    pub key_file: PathBuf,
    pub secrets: Vec<String>,
}
pub async fn vanilla(
    options: Options,
    provider: Arc<dyn Plugin>,
    interface: Arc<dyn Plugin>,
) -> Result<Arc<Harness>> {
    compose(options, provider, interface, default_runtime()).await
}
pub fn default_runtime() -> Arc<dyn Plugin> {
    if cfg!(feature = "durable-default") {
        Arc::new(runtime_durable::DurablePlugin)
    } else {
        Arc::new(runtime_transient::TransientPlugin)
    }
}
pub async fn compose(
    options: Options,
    provider: Arc<dyn Plugin>,
    interface: Arc<dyn Plugin>,
    runtime: Arc<dyn Plugin>,
) -> Result<Arc<Harness>> {
    compose_with(Harness::new(), options, provider, interface, runtime).await
}
async fn compose_with(
    harness: Arc<Harness>,
    options: Options,
    provider: Arc<dyn Plugin>,
    interface: Arc<dyn Plugin>,
    runtime: Arc<dyn Plugin>,
) -> Result<Arc<Harness>> {
    harness.configure_tenants(std::env::var("MODULAR_AGENT_TENANTS").ok().as_deref())?;
    let command_state = options.history.with_file_name("commands");
    let history: Arc<dyn Plugin> = match history_http::HttpHistory::from_env()? {
        Some(http) => Arc::new(history_http::HttpPlugin(http)),
        None => Arc::new(history_fs::HistoryPlugin {
            root: options.history,
        }),
    };
    let plugins: Vec<Arc<dyn Plugin>> = vec![
        Arc::new(
            config_files::FilesConfiguration::new(options.global_config)
                .with_defaults(json!({"approval":"off"})),
        ),
        history,
        Arc::new(credentials_file::FileCredentials {
            openai_key: options.key_file,
        }),
        Arc::new(environment_local::LocalPlugin {
            state: command_state,
            points: environment_local::PointStore::Copy,
        }),
        Arc::new(tools_builtin::BuiltinTools),
        Arc::new(tools_mcp::McpPlugin::default()),
        runtime,
        Arc::new(feature_jobs::JobsPlugin),
        Arc::new(feature_subagents::SubagentsPlugin::default()),
        Arc::new(feature_questions::QuestionsPlugin),
        Arc::new(feature_approval::ApprovalPlugin::default()),
        provider,
        Arc::new(feature_model::ModelPlugin),
        Arc::new(feature_prompt::PromptPlugin),
        Arc::new(feature_context::ContextPlugin),
        Arc::new(feature_commands::CommandsPlugin),
        Arc::new(guardrail::LiteralGuardrail {
            secrets: options.secrets,
        }),
        interface,
    ];
    for plugin in plugins {
        harness.load(plugin).await?;
    }
    if std::env::var("MODULAR_AGENT_CONFORMANCE").as_deref() == Ok("1") {
        harness
            .load(Arc::new(provider_fake::ConformancePlugin))
            .await?;
    }
    Ok(harness)
}
/// A composition is fixed to one project's trusted plugin plan. ACP creates one
/// composition per session; subagents inherit that composition and its project.
pub async fn compose_project(
    options: Options,
    provider: Arc<dyn Plugin>,
    interface: Arc<dyn Plugin>,
    runtime: Arc<dyn Plugin>,
    project: &std::path::Path,
) -> Result<Arc<Harness>> {
    let project = project.canonicalize()?;
    let plan = config_files::FilesConfiguration::new(options.global_config.clone())
        .plugin_plan(&project)?;
    let plugin_home = options.history.with_file_name("plugins");
    let h = compose_with(
        Harness::for_project(project.clone()),
        options,
        provider,
        interface,
        runtime,
    )
    .await?;
    for item in plan.as_array().unwrap() {
        let name = item["name"].as_str().unwrap();
        let opts = &item["options"];
        let plugin: Arc<dyn Plugin> = match name {
            "guardrail.literal" => Arc::new(guardrail::LiteralGuardrail {
                secrets: serde_json::from_value(opts.get("secrets").cloned().unwrap_or(json!([])))?,
            }),
            "feature.subagents" => Arc::new(feature_subagents::SubagentsPlugin {
                durable: opts["durable"].as_bool().unwrap_or(true),
                replacement: false,
            }),
            "tools.mcp" => Arc::new(tools_mcp::McpPlugin {
                servers: serde_json::from_value(opts.get("servers").cloned().unwrap_or(json!([])))?,
                service: Arc::default(),
            }),
            _ => bail!("unknown configured plugin {name}"),
        };
        h.load(Arc::new(ConfiguredPlugin(plugin))).await?;
    }
    if let Ok(value) = std::env::var("MODULAR_AGENT_PLUGINS") {
        let launches: Vec<plugin_stdio::ExternalLaunch> = serde_json::from_str(&value)?;
        for (index, launch) in launches.into_iter().enumerate() {
            if let Err(error) = launch
                .load(&h, &project, &plugin_home.join(index.to_string()), index)
                .await
            {
                let _ = h.shutdown().await;
                return Err(anyhow!("configured plugin {index} failed: {error:#}"));
            }
        }
    }
    if let Err(error) = h.load(Arc::new(ProjectComposition(project))).await {
        let _ = h.shutdown().await;
        return Err(error);
    }
    Ok(h)
}
struct ProjectComposition(PathBuf);
impl Plugin for ProjectComposition {
    fn name(&self) -> &str {
        "composition.project"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let project = self.0.clone();
        r.on(
            "session.prepare",
            Order::First,
            handler(move |api, scope, _| {
                let project = project.clone();
                Box::pin(async move {
                    ensure!(
                        api.snapshot(&scope.session)?.project == project,
                        "composition belongs to a different project"
                    );
                    Ok(HookResult::default())
                })
            }),
        );
        Ok(())
    }
}
struct ConfiguredPlugin(Arc<dyn Plugin>);
impl Plugin for ConfiguredPlugin {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn replaces(&self) -> Option<&str> {
        Some(self.0.name())
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        self.0.install(r)
    }
    fn stop(&self) -> Result<()> {
        self.0.stop()
    }
}
pub fn real_provider(state: PathBuf, mode: provider_openai::Mode) -> Arc<dyn Plugin> {
    Arc::new(provider_openai::OpenAiPlugin::new(mode, state))
}
pub fn fake_provider(scripts: Vec<provider_fake::Script>) -> Arc<dyn Plugin> {
    Arc::new(provider_fake::FakePlugin::new(scripts))
}
