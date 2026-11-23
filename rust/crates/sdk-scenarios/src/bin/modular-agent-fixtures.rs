//! The Rust fixture program (docs/sdk/testing.md#the-fixture-plugins): serves the named
//! fixture plugin over stdio or WebSocket.
use modular_agent::{ServeOptions, serve, serve_websocket, testing::fixtures::fixture};
use sdk_scenarios::telemetry;
use std::io::Write;

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
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
    } else if std::env::var(telemetry::HANDSHAKE).as_deref() == Ok("no-acceptance") {
        modular_agent::testing::serve_without_trace_acceptance(plugin).await
    } else {
        serve(plugin).await
    };
    telemetry::flush(export).await;
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
