use agent_api::*;
use std::sync::Arc;
pub struct ModelPlugin;
struct Selection;
impl Plugin for ModelPlugin {
    fn name(&self) -> &str {
        "model.selection"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn ModelSelection>("model.selection", Arc::new(Selection))?;
        for name in ["model", "thinking"] {
            r.command(
                name,
                handler(move |api, scope, value| {
                    Box::pin(async move {
                        let arg = value["args"].as_str().unwrap_or("").trim();
                        let data = api.snapshot(&scope.session)?;
                        if arg.is_empty() {
                            return Ok(answer(data.settings[name].clone()));
                        }
                        if name == "model" {
                            let found = api.capability_names("provider.").into_iter().any(|key| {
                                capability::<dyn Provider>(api.as_ref(), &key)
                                    .is_ok_and(|p| p.catalog().iter().any(|m| m.name == arg))
                            });
                            ensure!(found, "model not in Provider catalog");
                        } else {
                            let selector: Arc<dyn ModelSelection> =
                                capability(api.as_ref(), "model.selection")?;
                            let model = selector.select(api.clone(), &scope).await?;
                            ensure!(
                                model.info().thinking.iter().any(|t| t == arg),
                                "unsupported thinking level"
                            );
                        }
                        let result = api.settings(&scope, json!({name:arg}))?;
                        Ok(answer(result))
                    })
                }),
            )?;
        }
        Ok(())
    }
}
#[async_trait]
impl ModelSelection for Selection {
    async fn select(&self, api: Api, scope: &Scope) -> Result<Arc<dyn ModelAccess>> {
        let data = api.snapshot(&scope.session)?;
        let name = data.settings["model"]
            .as_str()
            .ok_or_else(|| anyhow!("model setting missing"))?;
        let mut matches = vec![];
        for key in api.capability_names("provider.") {
            let provider: Arc<dyn Provider> = capability(api.as_ref(), &key)?;
            if provider.catalog().iter().any(|m| m.name == name) {
                matches.push(provider);
            }
        }
        if matches.is_empty() {
            return Ok(Arc::new(UnavailableModel(name.into())));
        }
        ensure!(
            matches.len() == 1,
            "expected exactly one Provider for {name}"
        );
        matches[0].bind(name)
    }
}
struct UnavailableModel(String);
#[async_trait]
impl ModelAccess for UnavailableModel {
    fn info(&self) -> ModelInfo {
        ModelInfo {
            name: self.0.clone(),
            context_window: 128_000,
            output_limit: 8_192,
            thinking: vec![],
            keeps_state: false,
            runs_tools: false,
            extra: Value::Null,
        }
    }
    async fn generate(
        &self,
        _: Api,
        _: Scope,
        _: ModelRequest,
        _: CancellationToken,
    ) -> std::result::Result<ModelResponse, ModelFailure> {
        Err(ModelFailure {
            kind: FailureKind::Other,
            message: format!("recorded model {} is unavailable", self.0),
        })
    }
}
