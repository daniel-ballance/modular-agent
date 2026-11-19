//! Local chain caches are disposable. The durable inventory contains only remote
//! response IDs and request markers, so erasure can find old responses after restart.
use agent_api::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
};

pub(crate) struct Chain {
    pub response: String,
    pub input: Vec<Value>,
    pub instructions: Value,
}
#[derive(Default)]
struct Cache {
    revision: u64,
    chains: BTreeMap<String, Chain>,
}
pub(crate) struct State {
    pub gate: tokio::sync::Mutex<()>,
    cache: Mutex<Cache>,
    directory: PathBuf,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Inventory {
    pub responses: BTreeSet<String>,
    pub uncertain: BTreeSet<String>,
    pub purge_pending: bool,
    pub erasures: BTreeSet<String>,
}
pub(crate) fn safe_id(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 256
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "invalid Provider state identity"
    );
    Ok(())
}
impl State {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            gate: Default::default(),
            cache: Default::default(),
            directory,
        }
    }
    pub fn invalidate(&self, session: &str) {
        let mut cache = self.cache.lock().unwrap();
        cache.revision += 1;
        cache.chains.remove(session);
    }
    pub fn take(&self, session: &str) -> (u64, Option<Chain>) {
        let mut cache = self.cache.lock().unwrap();
        (cache.revision, cache.chains.remove(session))
    }
    pub fn keep(&self, session: String, revision: u64, chain: Chain) {
        let mut cache = self.cache.lock().unwrap();
        if cache.revision == revision {
            cache.chains.insert(session, chain);
        }
    }
    pub fn load(&self, session: &str) -> Result<Inventory> {
        safe_id(session)?;
        match fs::read(self.directory.join(format!("{session}.json"))) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Inventory::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn save(&self, session: &str, inventory: &Inventory) -> Result<()> {
        safe_id(session)?;
        fs::create_dir_all(&self.directory)?;
        let temporary = self.directory.join(format!(".{}.tmp", id()));
        let result = (|| -> Result<()> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec(inventory)?)?;
            file.sync_all()?;
            fs::rename(&temporary, self.directory.join(format!("{session}.json")))?;
            File::open(&self.directory)?.sync_all()?;
            Ok(())
        })();
        let _ = fs::remove_file(temporary);
        result
    }
}
