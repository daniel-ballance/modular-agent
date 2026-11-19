use agent_api::*;
pub struct CommandsPlugin;
impl Plugin for CommandsPlugin {
    fn name(&self) -> &str {
        "commands"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "input",
            Order::First,
            handler(|api, scope, value| {
                Box::pin(async move {
                    let text = value["text"].as_str().unwrap_or("");
                    let Some(command) = text.strip_prefix('/') else {
                        return Ok(answer(value));
                    };
                    let (name, args) = command
                        .split_once(char::is_whitespace)
                        .unwrap_or((command, ""));
                    let result = api.command(&scope, name, args.trim()).await?;
                    Ok(HookResult {
                        stopped: true,
                        ..answer(result)
                    })
                })
            }),
        );
        r.command(
            "commands",
            handler(|api, _, _| Box::pin(async move { Ok(answer(json!(api.commands()))) })),
        )?;
        r.command(
            "settings",
            handler(|api, scope, _| {
                Box::pin(async move { Ok(answer(api.snapshot(&scope.session)?.settings)) })
            }),
        )?;
        r.command(
            "sessions",
            handler(|api, scope, value| {
                Box::pin(async move {
                    let all = value["args"] == "all";
                    let data = api.snapshot(&scope.session)?;
                    let sessions = api.list(if all { None } else { Some(&data.project) })?;
                    Ok(answer(json!(
                        sessions
                            .iter()
                            .map(|s| json!({"id":s.id,"project":s.project}))
                            .collect::<Vec<_>>()
                    )))
                })
            }),
        )?;
        r.command(
            "move",
            handler(|api, scope, value| {
                Box::pin(async move {
                    let arg = value["args"].as_str().unwrap_or("");
                    api.move_position(
                        &scope,
                        if arg == "root" {
                            None
                        } else {
                            Some(arg.into())
                        },
                    )?;
                    Ok(answer(json!({"moved":true})))
                })
            }),
        )?;
        r.command("fork",handler(|api,scope,value|Box::pin(async move{
            let arg=value["args"].as_str().unwrap_or("");
            Ok(answer(json!({"session":api.fork(&scope,if arg.is_empty(){None}else{Some(arg.into())})?})))
        })))?;
        r.command(
            "erase",
            handler(|api, scope, value| {
                Box::pin(async move {
                    let ids = value["args"]
                        .as_str()
                        .unwrap_or("")
                        .split_whitespace()
                        .map(str::to_string)
                        .collect::<Vec<_>>();
                    ensure!(!ids.is_empty(), "give entry IDs to erase");
                    Ok(answer(json!(api.erase(&scope, ids).await?)))
                })
            }),
        )?;
        Ok(())
    }
}
