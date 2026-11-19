//! The Rust fixture program (docs/sdk/testing.md#the-fixture-plugins): serves the named
//! fixture plugin over the plugin binding on stdio.
use modular_agent::{serve, testing::fixtures::fixture};

#[tokio::main]
async fn main() {
    let name = std::env::args().nth(1).unwrap_or_default();
    let plugin = if name == "provider-script" {
        Some(modular_agent::Plugin::new("fixture.provider").setup(|r| {
            let script = r.config()["script"].clone();
            r.provider(modular_agent::testing::scripted_provider(script));
            Ok(())
        }))
    } else {
        fixture(&name)
    };
    let Some(plugin) = plugin else {
        eprintln!("no fixture named {name:?}");
        std::process::exit(2);
    };
    if let Err(e) = serve(plugin).await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
