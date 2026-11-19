use agent_api::*;
use std::sync::Arc;
pub struct PromptPlugin;
impl Plugin for PromptPlugin {
    fn name(&self) -> &str {
        "system.prompt"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on("before.turn",Order::Normal,handler(|api,scope,_|Box::pin(async move {
            let session=api.snapshot(&scope.session)?;
            let env:Arc<dyn WorkingEnvironment>=capability(api.as_ref(),"environment")?;
            let env=env.scoped(api.clone(),scope.clone(),api.cancellation(&scope.session)?).unwrap_or(env);
            let instructions=match env.read(&session.project,"AGENTS.md").await {
                Ok(text)=>text,
                Err(error) if is_file_not_found(&error) ||
                    error.downcast_ref::<std::io::Error>().is_some_and(|e|
                        e.kind() == std::io::ErrorKind::Unsupported) => String::new(),
                Err(error)=>return Err(error),
            };
            Ok(answer(json!({"system": format!("You are a helpful agent. Use tools when needed. All relative paths refer to the session project: {}.\n\nProject AGENTS.md:\n{}",session.project.display(),instructions), "sources": []})))
        })));
        Ok(())
    }
}
