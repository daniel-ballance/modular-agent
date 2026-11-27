//! Disposable service for the shared history kit.
use modular_agent::{
    FileHistoryOptions, Result, ServeHistoryOptions, portable_file_history_with_options,
    serve_history,
};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let (address, token, store, restore_witness) = match args.as_slice() {
        [_, address, token, store] => (address, token, store, None),
        [_, address, token, store, flag, path] if flag == "--restore-witness" => {
            (address, token, store, Some(path.into()))
        }
        _ => {
            return Err(modular_agent::Error::new(
                modular_agent::Code::InvalidParams,
                "usage: history_service ADDRESS TOKEN_FILE STORE_DIR [--restore-witness PATH]",
            ));
        }
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
        portable_file_history_with_options(
            store,
            opts.lease_ttl,
            opts.max_sessions,
            FileHistoryOptions { restore_witness },
        )?,
        opts,
    )
    .await
}
