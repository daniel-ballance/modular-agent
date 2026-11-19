//! File configuration and an external, canonical-path project trust ledger.
use agent_api::*;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
#[derive(Clone)]
pub struct FilesConfiguration {
    pub global: PathBuf,
}
fn read(path: &Path) -> Result<Value> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)?;
            ensure!(value.is_object(), "settings must be an object");
            Ok(value)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
impl FilesConfiguration {
    fn trust_path(&self) -> PathBuf {
        self.global.with_file_name("trusted-projects.json")
    }
    pub fn trusted(&self, project: &Path) -> Result<bool> {
        let path = project.canonicalize()?;
        Ok(read(&self.trust_path())?[path.to_string_lossy().as_ref()] == true)
    }
    /// Called only by an explicit outside user/host action, never by project settings.
    pub fn trust(&self, project: &Path) -> Result<()> {
        let path = project.canonicalize()?;
        let mut ledger = read(&self.trust_path())?;
        ledger[path.to_string_lossy().as_ref()] = json!(true);
        std::fs::create_dir_all(self.trust_path().parent().unwrap())?;
        let temporary = self.trust_path().with_extension(format!("{}.tmp", id()));
        std::fs::write(&temporary, serde_json::to_vec_pretty(&ledger)?)?;
        std::fs::rename(temporary, self.trust_path())?;
        Ok(())
    }
    pub fn plugin_plan(&self, project: &Path) -> Result<Value> {
        let global = read(&self.global)?;
        let project = if self.trusted(project)? {
            read(&project.join(".modular-agent.json"))?
        } else {
            json!({})
        };
        let mut plugins = serde_json::Map::new();
        let mut order = Vec::new();
        for layer in [&global, &project] {
            if let Some(list) = layer.get("plugins") {
                for item in list
                    .as_array()
                    .ok_or_else(|| anyhow!("plugins must be an array"))?
                {
                    let name = item["name"]
                        .as_str()
                        .ok_or_else(|| anyhow!("plugin needs name"))?;
                    let options = item.get("options").cloned().unwrap_or(json!({}));
                    ensure!(options.is_object(), "plugin options must be an object");
                    if !plugins.contains_key(name) {
                        order.push(name.to_string());
                    }
                    merge(
                        plugins.entry(name.to_string()).or_insert(json!({})),
                        options,
                    );
                }
            }
            if let Some(options) = layer.get("plugin_settings") {
                for (name, patch) in options
                    .as_object()
                    .ok_or_else(|| anyhow!("plugin_settings must be an object"))?
                {
                    ensure!(patch.is_object(), "plugin options must be an object");
                    if let Some(existing) = plugins.get_mut(name) {
                        merge(existing, patch.clone());
                    }
                }
            }
        }
        Ok(json!(
            order
                .into_iter()
                .map(|name| json!({"name":name,"options":plugins[&name]}))
                .collect::<Vec<_>>()
        ))
    }
}
impl Plugin for FilesConfiguration {
    fn name(&self) -> &str {
        "configuration.files"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn Configuration>("configuration", Arc::new(self.clone()))
    }
}
impl Configuration for FilesConfiguration {
    fn settings(&self, project: &Path) -> Result<Value> {
        let mut settings = json!({"model":"gpt-6-luna","thinking":"low","step_limit":12,"output_limit":2048,"context_tokens":24000});
        for path in [&self.global, &project.join(".modular-agent.json")] {
            let mut layer = read(path)?;
            // Executable plugin configuration is not a session default or history content.
            for key in ["plugins", "plugin_settings", "mcp_servers"] {
                layer.as_object_mut().unwrap().remove(key);
            }
            layer
                .as_object_mut()
                .unwrap()
                .retain(|key, _| !key.starts_with('_'));
            merge(&mut settings, layer);
        }
        Ok(settings)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trust_separates_session_defaults_from_project_execution() -> Result<()> {
        let root = tempfile::tempdir()?;
        let project = root.path().join("project");
        std::fs::create_dir(&project)?;
        let c = FilesConfiguration {
            global: root.path().join("settings.json"),
        };
        std::fs::write(
            &c.global,
            r#"{"plugins":[{"name":"guardrail.literal","options":{"secrets":["global"]}}]}"#,
        )?;
        std::fs::write(
            project.join(".modular-agent.json"),
            r#"{"model":"fake","trusted":true,"plugins":[{"name":"tools.mcp","options":{"servers":[]}}],"plugin_settings":{"guardrail.literal":{"secrets":["project"]}}}"#,
        )?;
        assert_eq!(c.settings(&project)?["model"], "fake");
        assert!(c.settings(&project)?.get("plugins").is_none());
        assert_eq!(
            c.plugin_plan(&project)?,
            json!([{"name":"guardrail.literal","options":{"secrets":["global"]}}])
        );
        c.trust(&project)?;
        assert_eq!(
            c.plugin_plan(&project)?,
            json!([{"name":"guardrail.literal","options":{"secrets":["project"]}},{"name":"tools.mcp","options":{"servers":[]}}])
        );
        assert!(c.trusted(&project.join("."))?);
        Ok(())
    }
}
