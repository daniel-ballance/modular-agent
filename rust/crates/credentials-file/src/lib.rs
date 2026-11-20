use agent_api::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::Arc,
};

/// Paths, never values, are configured. The Provider key is read only at request time.
pub struct FileCredentials {
    pub openai_key: PathBuf,
}
impl Plugin for FileCredentials {
    fn name(&self) -> &str {
        "credentials.file"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn CredentialStore>(
            "credentials",
            Arc::new(Self {
                openai_key: self.openai_key.clone(),
            }),
        )
    }
}
impl FileCredentials {
    fn answers(&self) -> SecretFile {
        SecretFile(
            self.openai_key
                .with_file_name("answers")
                .join("credentials.json"),
        )
    }
}
impl CredentialStore for FileCredentials {
    fn get(&self, name: &str) -> Result<String> {
        ensure!(self.accepts(name), "invalid answer credential name");
        if let Some(value) = self.answers().read_optional(name)? {
            return Ok(value);
        }
        // Read names kept by older base builds. New writes go to the journal.
        std::fs::read_to_string(self.openai_key.with_file_name("answers").join(name))
            .map_err(|_| anyhow!("credential unavailable"))
    }
    fn provider(&self, claim: &CredentialClaim, name: &str) -> Result<String> {
        ensure!(
            name == "openai" && claim.covers(name),
            "Provider did not claim the credential"
        );
        let value = std::fs::read_to_string(&self.openai_key)
            .map_err(|_| anyhow!("OpenAI credential file unavailable"))?
            .trim()
            .to_string();
        ensure!(!value.is_empty(), "OpenAI credential file empty");
        Ok(value)
    }
    fn accepts(&self, name: &str) -> bool {
        name != "openai" && valid_name(name)
    }
    fn writable(&self) -> bool {
        true
    }
    fn put(&self, name: &str, value: &str) -> Result<()> {
        ensure!(self.accepts(name), "invalid answer credential name");
        self.answers().write(name, value)
    }
    fn stage(&self, receipt: StagingReceipt, value: &str) -> Result<()> {
        ensure!(
            self.accepts(&receipt.name),
            "invalid answer credential name"
        );
        self.answers().stage(receipt, value)
    }
    fn lookup_staged(&self, request: &SecretRequest) -> Result<Option<StagingReceipt>> {
        self.answers().lookup(request)
    }
    fn activate(&self, request: &SecretRequest) -> Result<Activation> {
        self.answers().activate(request)
    }
    fn discard(&self, request: &SecretRequest) -> Result<()> {
        self.answers().discard(request)
    }
}

/// The file is a deployment-local namespace. Its owner controls its directory.
pub struct SecretFile(pub PathBuf);
#[derive(Default, Serialize, Deserialize)]
struct Contents {
    #[serde(default)]
    answers: BTreeMap<String, String>,
    #[serde(default)]
    staging: SecretJournal,
}
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
impl SecretFile {
    fn load(&self) -> Result<Contents> {
        match std::fs::OpenOptions::new().read(true).open(&self.0) {
            Ok(file) => {
                ensure!(
                    file.metadata()?.permissions().mode() & 0o077 == 0,
                    "credential file must be owner-only"
                );
                serde_json::from_reader(file).map_err(|_| anyhow!("invalid credential file"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Contents::default()),
            Err(e) => Err(e.into()),
        }
    }
    fn transaction<T>(&self, update: impl FnOnce(&mut Contents) -> Result<T>) -> Result<T> {
        let parent = self
            .0
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(std::path::Path::new("."));
        std::fs::create_dir_all(parent)?;
        let name = self
            .0
            .file_name()
            .ok_or_else(|| anyhow!("credential file must have a name"))?;
        let lock_path = parent.join(format!(".{}.lock", name.to_string_lossy()));
        let lock = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(lock_path)?;
        fs2::FileExt::lock_exclusive(&lock)?;
        let mut state = self.load()?;
        let result = update(&mut state)?;
        let path = parent.join(format!(".secrets-{}.tmp", id()));
        let committed = (|| -> Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            file.write_all(&serde_json::to_vec(&state)?)?;
            file.sync_all()?;
            std::fs::rename(&path, &self.0)?;
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if committed.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        committed.map_err(|_| anyhow!("credential store commit failed"))?;
        Ok(result)
    }
    fn read_optional(&self, name: &str) -> Result<Option<String>> {
        Ok(self.load()?.answers.remove(name))
    }
    pub fn read(&self, name: &str) -> Result<String> {
        self.read_optional(name)?
            .ok_or_else(|| anyhow!("credential unavailable"))
    }
    pub fn write(&self, name: &str, value: &str) -> Result<()> {
        ensure!(valid_name(name), "invalid credential name");
        self.transaction(|state| {
            state
                .staging
                .replace(&mut state.answers, name, Some(value.into()))
        })
    }
    pub fn stage(&self, receipt: StagingReceipt, value: &str) -> Result<()> {
        ensure!(valid_name(&receipt.name), "invalid credential name");
        self.transaction(|state| state.staging.stage(receipt, value))
    }
    pub fn lookup(&self, request: &SecretRequest) -> Result<Option<StagingReceipt>> {
        Ok(self.load()?.staging.lookup(request))
    }
    pub fn activate(&self, request: &SecretRequest) -> Result<Activation> {
        self.transaction(|state| state.staging.activate(request, &mut state.answers))
    }
    pub fn discard(&self, request: &SecretRequest) -> Result<()> {
        self.transaction(|state| {
            state.staging.discard(request);
            Ok(())
        })
    }
}
