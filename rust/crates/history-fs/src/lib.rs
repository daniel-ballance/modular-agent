//! Atomic JSON snapshots with OS-owned session writer leases.
use agent_api::*;
use fs2::FileExt;
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};
#[cfg(target_os = "linux")]
use std::{
    hash::{Hash, Hasher},
    os::{
        linux::net::SocketAddrExt,
        unix::net::{SocketAddr, UnixListener},
    },
};

fn decode(bytes: &[u8]) -> Result<SessionData> {
    let v: Value = serde_json::from_slice(bytes)?;
    if v.get("historyBinding").is_none() {
        return Ok(serde_json::from_value(v)?);
    }
    let mut data = portable::session(
        &v,
        v["entries"]
            .as_array()
            .ok_or_else(|| anyhow!("entries required"))?,
    )?;
    let mut defaults = v.get("defaults").cloned().unwrap_or(json!({}));
    merge(&mut defaults, data.settings);
    data.settings = defaults;
    data.plugins = serde_json::from_value(v["plugins"].clone())?;
    Ok(data)
}
fn encode(data: &SessionData) -> Result<Value> {
    let entries = data
        .entries
        .iter()
        .filter(|e| e.writer != "rust.derived")
        .map(|e| portable::entry(e, data))
        .collect::<Result<Vec<_>>>()?;
    let mut v = json!({"historyBinding":"modular-agent-data/1","id":data.id,"project":data.project,"defaults":data.settings,"plugins":data.plugins,"entries":entries});
    if let Some((parent, entry)) = &data.origin {
        v["parentSessionId"] = json!(parent);
        if let Some(entry) = entry {
            v["forkedFrom"] = json!({"sessionId":parent,"entryId":entry});
        }
    }
    Ok(v)
}
pub struct FileHistory {
    root: PathBuf,
}
pub struct HistoryPlugin {
    pub root: PathBuf,
}
impl Plugin for HistoryPlugin {
    fn name(&self) -> &str {
        "history.files"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn HistoryStore>("history", Arc::new(FileHistory::new(&self.root)?))
    }
}
struct SessionLease {
    #[cfg(target_os = "linux")]
    _listener: UnixListener,
    #[cfg(target_os = "macos")]
    _file: File,
}
impl Lease for SessionLease {}
struct StoreLock(File);
impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
impl FileHistory {
    pub fn new(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        Ok(Self {
            root: root.canonicalize()?,
        })
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        ensure!(
            !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
            "invalid session id"
        );
        Ok(self.root.join(format!("{id}.json")))
    }
    fn lock(&self) -> Result<StoreLock> {
        let f = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(self.root.join(".store.lock"))?;
        f.lock_exclusive()?;
        Ok(StoreLock(f))
    }
    fn load_unlocked(&self, id: &str) -> Result<SessionData> {
        decode(&fs::read(self.path(id)?)?)
    }
    fn all_unlocked(&self) -> Result<Vec<SessionData>> {
        let mut result = vec![];
        for entry in fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json") {
                result.push(decode(&fs::read(path)?)?);
            }
        }
        result.sort_by(|a: &SessionData, b| a.id.cmp(&b.id));
        Ok(result)
    }
    fn save_unlocked(&self, data: &SessionData) -> Result<()> {
        let target = self.path(&data.id)?;
        let tmp = self.root.join(format!(".{}.tmp", id()));
        let result = (|| -> Result<()> {
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            f.write_all(&serde_json::to_vec(&encode(data)?)?)?;
            f.sync_all()?;
            fs::rename(&tmp, &target)?;
            File::open(&self.root)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
        }
        result
    }
}
impl HistoryStore for FileHistory {
    fn supports_erasure(&self) -> bool {
        true
    }
    fn supports_service_snapshots(&self) -> bool {
        true
    }
    #[cfg(target_os = "linux")]
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>> {
        self.path(session)?;
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.root.hash(&mut hash);
        let name = format!("modular-agent-{:016x}-{session}", hash.finish());
        // The kernel releases this address on exit. No empty session lock file remains.
        // https://doc.rust-lang.org/std/os/linux/net/trait.SocketAddrExt.html
        let address = SocketAddr::from_abstract_name(name.as_bytes())?;
        // A concurrent fork inherits CLOEXEC descriptors until exec. A bounded
        // retry distinguishes that brief window from a genuinely held lease.
        for attempt in 0..=50 {
            match UnixListener::bind_addr(&address) {
                Ok(listener) => {
                    return Ok(Box::new(SessionLease {
                        _listener: listener,
                    }));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && attempt < 50 => {
                    std::thread::sleep(std::time::Duration::from_millis(3))
                }
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                    return Err(OperationError::Busy(format!(
                        "session {session} is already held by another writer"
                    ))
                    .into());
                }
                Err(e) => return Err(e.into()),
            }
        }
        unreachable!()
    }
    #[cfg(target_os = "macos")]
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>> {
        self.path(session)?;
        // Leave the inode in place: unlinking a lease file would allow two writers.
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(self.root.join(format!(".{session}.lease")))?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Box::new(SessionLease { _file: file })),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Err(OperationError::Busy(
                format!("session {session} is already held by another writer"),
            )
            .into()),
            Err(e) => Err(e.into()),
        }
    }
    fn load(&self, session: &str) -> Result<SessionData> {
        let _lock = self.lock()?;
        self.load_unlocked(session)
    }
    fn save(&self, data: &SessionData) -> Result<()> {
        let _lock = self.lock()?;
        self.save_unlocked(data)
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        let _lock = self.lock()?;
        Ok(self
            .all_unlocked()?
            .into_iter()
            .filter(|s| project.is_none_or(|p| s.project == p))
            .collect())
    }
    fn erase(&self, entries: Vec<String>, held: &[String]) -> Result<Vec<SessionData>> {
        let _lock = self.lock()?;
        let mut sessions = self.all_unlocked()?;
        let mut erased: BTreeSet<_> = entries.into_iter().collect();
        loop {
            let before = erased.len();
            // Admission and taking input are two records of the same input, not
            // independently erasable copies of its text.
            for s in &sessions {
                for e in &s.entries {
                    if e.kind == "input" && erased.contains(&e.id) {
                        erased.extend(e.copies.iter().cloned());
                    }
                }
            }
            for s in &sessions {
                for e in &s.entries {
                    if e.copies.iter().any(|x| erased.contains(x)) {
                        erased.insert(e.id.clone());
                    }
                }
            }
            if before == erased.len() {
                break;
            }
        }
        let mut leases = vec![];
        let affected: Vec<_> = sessions
            .iter()
            .filter(|s| s.entries.iter().any(|e| erased.contains(&e.id)))
            .map(|s| s.id.clone())
            .collect();
        for id in &affected {
            if !held.contains(id) {
                leases.push(self.acquire(id)?);
            }
        }
        let mut changed = vec![];
        for session in &mut sessions {
            if !affected.contains(&session.id) {
                continue;
            }
            let erased_settings = session
                .entries
                .iter()
                .any(|e| e.kind == "settings" && erased.contains(&e.id));
            let entry_ids = session
                .entries
                .iter()
                .filter(|e| erased.contains(&e.id) && !authority_record(e))
                .map(|e| e.id.clone())
                .collect::<Vec<_>>();
            let input_keys = erased_input_keys(session, &entry_ids);
            for entry in &mut session.entries {
                if erased.contains(&entry.id) && !authority_record(entry) {
                    entry.content = None;
                    entry.visible = false;
                }
            }
            // Avoid retaining an erased setting in the materialized session header.
            if erased_settings {
                session.settings = json!({});
            }
            if let Some(settings) = session
                .entries
                .iter()
                .rev()
                .find(|e| e.kind == "settings")
                .and_then(|e| e.content.clone())
            {
                session.settings = settings;
            }
            record_erasure(session, entry_ids, input_keys);
            self.save_unlocked(session)?;
            changed.push(session.clone());
        }
        Ok(changed)
    }
}
