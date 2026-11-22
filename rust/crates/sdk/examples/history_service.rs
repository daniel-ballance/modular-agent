//! Disposable service for the shared history kit.
use modular_agent::{Result, ServeHistoryOptions, portable_file_history, serve_history};
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
    // The kit waits for expiry and checks a restart with a shorter lease.
    opts.lease_ttl = match std::env::var("MODULAR_AGENT_KIT_RESTART_PHASE").as_deref() {
        Ok("initial") => Duration::from_secs(6),
        Ok("restart") => Duration::from_secs(1),
        _ => Duration::from_millis(2500),
    };
    serve_history(
        portable_file_history(store, opts.lease_ttl, opts.max_sessions)?,
        opts,
    )
    .await
}
