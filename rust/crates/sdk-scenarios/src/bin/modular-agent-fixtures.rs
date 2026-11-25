//! The Rust fixture program (docs/sdk/testing.md#the-fixture-plugins): serves the named
//! fixture plugin over stdio or WebSocket.
#[path = "acp_waiting/mod.rs"]
mod acp_waiting;

use modular_agent::{
    AcpOptions, Actor, Agent, Durability, ServeOptions, serve, serve_websocket,
    testing::fixtures::fixture,
};
use sdk_scenarios::telemetry;
use std::io::Write;

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["acp-waiting"] {
        if let Err(error) = acp_waiting::serve().await {
            eprintln!("ACP waiting fixture: {error:#}");
            std::process::exit(1);
        }
        return;
    }
    if args == ["acp-stdio-rights"] {
        if let Err(error) = serve_stdio_rights().await {
            eprintln!("ACP stdio rights fixture: {error:#}");
            std::process::exit(1);
        }
        return;
    }
    let (name, options) = match args.as_slice() {
        [name] => (name, None),
        [name, flag, listen, token_flag, token_file]
            if flag == "--listen" && token_flag == "--token-file" =>
        {
            (
                name,
                Some(ServeOptions {
                    listen: listen.clone(),
                    token_file: token_file.into(),
                    tls: None,
                    projects: vec![],
                }),
            )
        }
        _ => {
            eprintln!("usage: modular-agent-fixtures FIXTURE [--listen ADDR --token-file FILE]");
            std::process::exit(2);
        }
    };
    let plugin = if name == "provider-script" {
        Some(modular_agent::Plugin::new("fixture.provider").setup(|r| {
            let script = r.config()["script"].clone();
            r.provider(modular_agent::testing::scripted_provider(script));
            Ok(())
        }))
    } else {
        fixture(name)
    };
    let Some(plugin) = plugin else {
        eprintln!("no fixture named {name:?}");
        std::process::exit(2);
    };
    let export = telemetry::install(std::env::var_os(telemetry::ENDPOINT).is_some());
    let result = if let Some(options) = options {
        async {
            let server = serve_websocket(plugin, options).await?;
            println!("{}", server.url);
            std::io::stdout().flush()?;
            let stopped = tokio::signal::ctrl_c().await;
            server.close().await;
            Ok(stopped?)
        }
        .await
    } else {
        serve(plugin).await
    };
    telemetry::flush(export).await;
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

async fn serve_stdio_rights() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::var("MODULAR_AGENT_DATA_DIR")?;
    if std::env::var("MODULAR_AGENT_CONFORMANCE").as_deref() != Ok("1") || dir.is_empty() {
        return Err("acp-stdio-rights requires a disposable conformance directory".into());
    }
    let rights = match std::env::var("MA_ACP_STDIO_RIGHTS") {
        Ok(raw) => Some(serde_json::from_str(&raw)?),
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => return Err(error.into()),
    };
    let agent = Agent::builder()
        .plugin_host(true)
        .data_dir(dir)
        .durability(Durability::Kept)
        .provider(modular_agent::testing::scripted_provider(
            serde_json::json!([{"text": "First turn."}, {"text": "Second turn."}]),
        ))
        .build()
        .await?;
    let actor = Actor {
        id: "rights-fixture".into(),
        kind: "host".into(),
        rights: modular_agent::Rights::only(&["watch", "input", "settings"]),
    };
    agent
        .serve_acp(AcpOptions {
            actor: Some(actor),
            rights,
            ..Default::default()
        })
        .await?;
    agent.close().await?;
    Ok(())
}
