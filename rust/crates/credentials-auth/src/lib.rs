//! The credential store of the standard configuration: one file, `auth.json`,
//! readable only by its owner. It keeps a sign-in per Provider (an OAuth token
//! set or an API key) and the named secrets a person gave in answer to a
//! question. Providers refresh their own tokens through [`AuthFile::update`],
//! which holds a lock across processes so two agents never spend the same
//! refresh token.
use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Login {
    Oauth {
        access: String,
        refresh: String,
        /// Milliseconds since the epoch, already brought forward by the refresh margin.
        expires: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
    },
    ApiKey {
        key: String,
    },
}
impl Login {
    /// What a request presents.
    pub fn secret(&self) -> &str {
        match self {
            Self::Oauth { access, .. } => access,
            Self::ApiKey { key } => key,
        }
    }
    pub fn expired(&self) -> bool {
        matches!(self, Self::Oauth { expires, .. } if *expires <= now_ms())
    }
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Default, Serialize, Deserialize)]
struct Contents {
    #[serde(default)]
    logins: std::collections::BTreeMap<String, Login>,
    #[serde(default)]
    answers: std::collections::BTreeMap<String, String>,
}

#[derive(Clone)]
pub struct AuthFile {
    pub path: PathBuf,
    /// Names that are Provider sign-ins, never the target of a secret answer.
    pub providers: Vec<String>,
}
struct Locked(File);
impl Drop for Locked {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}
impl AuthFile {
    pub fn new(path: PathBuf, providers: &[&str]) -> Self {
        Self {
            path,
            providers: providers.iter().map(|p| p.to_string()).collect(),
        }
    }
    fn read(&self) -> Result<Contents> {
        match std::fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)
                .map_err(|_| anyhow!("{} is not a valid credential file", self.path.display()))?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Contents::default()),
            Err(e) => Err(e.into()),
        }
    }
    fn write(&self, contents: &Contents) -> Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| anyhow!("credential file has no directory"))?;
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".auth-{}.tmp", uuid::Uuid::new_v4()));
        let result: Result<()> = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec_pretty(contents)?)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &self.path)?;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result.map_err(|_| anyhow!("the credential file could not be written"))
    }
    fn lock(&self) -> Result<Locked> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| anyhow!("credential file has no directory"))?;
        std::fs::create_dir_all(parent)?;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(self.path.with_extension("lock"))?;
        fs2::FileExt::lock_exclusive(&file)?;
        Ok(Locked(file))
    }
    /// Operator use, as `ma auth` and `ma login` do. Plugins get a sign-in
    /// from their own bounded sign-in handle.
    pub fn login(&self, provider: &str) -> Result<Option<Login>> {
        Ok(self.read()?.logins.remove(provider))
    }
    /// Operator use.
    pub fn set_login(&self, provider: &str, login: Option<Login>) -> Result<()> {
        let _lock = self.lock()?;
        let mut contents = self.read()?;
        match login {
            Some(login) => contents.logins.insert(provider.into(), login),
            None => contents.logins.remove(provider),
        };
        self.write(&contents)
    }
    /// The Provider's current sign-in, refreshed first when it has expired.
    /// `refresh` runs with the file locked against other agents, on the value
    /// read under that lock, so a token another process just refreshed is used
    /// instead of being spent again.
    pub async fn current<F, Fut>(
        &self,
        provider: &str,
        rejected: Option<&str>,
        refresh: F,
    ) -> Result<Login>
    where
        F: FnOnce(Login) -> Fut,
        Fut: std::future::Future<Output = Result<Login>>,
    {
        let needs_refresh = |login: &Login| {
            login.expired()
                || matches!(login, Login::Oauth { access, .. } if Some(access.as_str()) == rejected)
        };
        let missing = || anyhow!("not signed in to {provider}; run `ma login {provider}`");
        let login = self.login(provider)?.ok_or_else(missing)?;
        if !needs_refresh(&login) {
            return Ok(login);
        }
        let this = self.clone();
        let lock = tokio::task::spawn_blocking(move || this.lock()).await??;
        let login = self.login(provider)?.ok_or_else(missing)?;
        if !needs_refresh(&login) {
            return Ok(login);
        }
        let fresh = refresh(login).await?;
        let mut contents = self.read()?;
        contents.logins.insert(provider.into(), fresh.clone());
        self.write(&contents)?;
        drop(lock);
        Ok(fresh)
    }
    fn answer_name(&self, name: &str) -> Result<()> {
        ensure!(
            !name.is_empty()
                && name.len() <= 128
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "invalid credential name"
        );
        ensure!(
            !self.providers.iter().any(|p| p == name),
            "a Provider sign-in cannot be replaced by an answer"
        );
        Ok(())
    }
}

impl AuthFile {
    pub fn answer(&self, name: &str) -> Result<String> {
        self.answer_name(name)?;
        self.read()?
            .answers
            .remove(name)
            .ok_or_else(|| anyhow!("no credential named {name}"))
    }

    pub fn accepts(&self, name: &str) -> bool {
        self.answer_name(name).is_ok()
    }

    pub fn put_answer(&self, name: &str, value: &str) -> Result<()> {
        self.answer_name(name)?;
        let _lock = self.lock()?;
        let mut contents = self.read()?;
        contents.answers.insert(name.into(), value.into());
        self.write(&contents)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn rust_auth_fixture_round_trips_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthFile::new(dir.path().join("auth.json"), &["openai-codex", "xai"]);
        let fixture = include_bytes!("../tests/fixtures/auth.json");
        std::fs::write(&auth.path, fixture).unwrap();
        assert_eq!(auth.answer("named-answer").unwrap(), "fixture");
        assert!(auth.put_answer("xai", "refused").is_err());
        auth.set_login("openai-codex", auth.login("openai-codex").unwrap())
            .unwrap();
        assert_eq!(std::fs::read(&auth.path).unwrap(), fixture);
        assert_eq!(
            std::fs::metadata(&auth.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn refresh_competes_under_the_file_lock_and_only_spends_once() {
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthFile::new(dir.path().join("auth.json"), &["xai"]);
        auth.set_login(
            "xai",
            Some(Login::Oauth {
                access: "before".into(),
                refresh: "fixture".into(),
                expires: 0,
                account: None,
            }),
        )
        .unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let refresh = move |_| {
            let count = count.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                Ok(Login::Oauth {
                    access: "after".into(),
                    refresh: "next".into(),
                    expires: u64::MAX,
                    account: None,
                })
            }
        };
        let a = auth.current("xai", None, refresh.clone());
        let b = auth.current("xai", Some("before"), refresh);
        let (a, b) = tokio::join!(a, b);
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(observed.load(Ordering::SeqCst), 1);
        assert!(dir.path().join("auth.lock").is_file());
    }
}
