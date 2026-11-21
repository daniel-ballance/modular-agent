use modular_agent::{Result, ServeHistoryOptions, file_history, listen_history};
use std::{io::Write, net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [store, token_file] = args.as_slice() else {
        eprintln!("Usage: project-notes-history STORE TOKEN_FILE");
        std::process::exit(2);
    };
    let options = ServeHistoryOptions::new(SocketAddr::from(([127, 0, 0, 1], 0)), token_file);
    let service = listen_history(file_history(store)?, options).await?;
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    println!("{}", service.url);
    std::io::stdout().flush()?;
    term.recv().await;
    service.close().await;
    Ok(())
}
