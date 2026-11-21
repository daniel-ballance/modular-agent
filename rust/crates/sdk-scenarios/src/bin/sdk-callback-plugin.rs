#[path = "../../tests/support/callback_progress.rs"]
mod fixture;

#[tokio::main]
async fn main() -> modular_agent::Result<()> {
    modular_agent::serve(fixture::progress_plugin()).await
}
