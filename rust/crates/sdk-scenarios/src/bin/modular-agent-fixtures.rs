//! The Rust fixture program (docs/sdk/testing.md#the-fixture-plugins): serves the named
//! fixture plugin over the plugin binding on stdio.
use modular_agent::{serve, testing::fixtures::fixture};

#[tokio::main]
async fn main() {
    let name = std::env::args().nth(1).unwrap_or_default();
    let Some(plugin) = fixture(&name) else {
        eprintln!("no fixture named {name:?}");
        std::process::exit(2);
    };
    if let Err(e) = serve(plugin).await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
