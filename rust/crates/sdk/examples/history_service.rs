//! Disposable service for the shared history kit.
use modular_agent::{Result, ServeHistoryOptions, file_history, serve_history};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let [_, address, token, store] = args.as_slice() else {
        return Err(modular_agent::Error::new(
            modular_agent::Code::InvalidParams,
            "usage: history_service ADDRESS TOKEN_FILE STORE_DIR",
        ));
    };
    let mut opts = ServeHistoryOptions::new(
        address.parse().map_err(|_| {
            modular_agent::Error::new(modular_agent::Code::InvalidParams, "invalid listen address")
        })?,
        token,
    );
    opts.ttl = match std::env::var("MODULAR_AGENT_KIT_RESTART_PHASE").as_deref() {
        Ok("initial") => Duration::from_millis(6000),
        Ok("restart") => Duration::from_millis(1000),
        _ => opts.ttl,
    };
    serve_history(file_history(store)?, opts).await
}
