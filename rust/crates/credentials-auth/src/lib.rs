//! The credential store of the standard configuration: one file, `auth.json`,
//! readable only by its owner. It keeps a sign-in per Provider (an OAuth token
//! set or an API key) and the named secrets a person gave in answer to a
//! question. Providers refresh their own tokens through [`AuthFile::update`],
//! which holds a lock across processes so two agents never spend the same
//! refresh token.
use agent_api::*;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::Arc,
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
        let temporary = parent.join(format!(".auth-{}.tmp", id()));
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
    pub fn login(&self, provider: &str) -> Result<Option<Login>> {
        Ok(self.read()?.logins.remove(provider))
    }
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
    pub async fn current<F, Fut>(&self, provider: &str, refresh: F) -> Result<Login>
    where
        F: FnOnce(Login) -> Fut,
        Fut: std::future::Future<Output = Result<Login>>,
    {
        let missing = || anyhow!("not signed in to {provider}; run `ma login {provider}`");
        let login = self.login(provider)?.ok_or_else(missing)?;
        if !login.expired() {
            return Ok(login);
        }
        let this = self.clone();
        let lock = tokio::task::spawn_blocking(move || this.lock()).await??;
        let login = self.login(provider)?.ok_or_else(missing)?;
        if !login.expired() {
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
impl Plugin for AuthFile {
    fn name(&self) -> &str {
        "credentials.auth"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn CredentialStore>("credentials", Arc::new(self.clone()))?;
        r.provide::<AuthFile>("credentials.auth", Arc::new(self.clone()))
    }
}
impl CredentialStore for AuthFile {
    fn get(&self, name: &str) -> Result<String> {
        let mut contents = self.read()?;
        if let Some(login) = contents.logins.get(name) {
            return Ok(login.secret().to_owned());
        }
        contents
            .answers
            .remove(name)
            .ok_or_else(|| anyhow!("no credential named {name}"))
    }
    fn put(&self, name: &str, value: &str) -> Result<()> {
        self.answer_name(name)?;
        let _lock = self.lock()?;
        let mut contents = self.read()?;
        contents.answers.insert(name.into(), value.into());
        self.write(&contents)
    }
    fn writable(&self) -> bool {
        true
    }
    fn accepts(&self, name: &str) -> bool {
        self.answer_name(name).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_login_is_refreshed_once_and_kept_private() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let auth = AuthFile::new(dir.path().join("auth.json"), &["xai"]);
        assert!(auth.current("xai", |l| async { Ok(l) }).await.is_err());
        let stale = Login::Oauth {
            access: "old".into(),
            refresh: "r1".into(),
            expires: 1,
            account: None,
        };
        auth.set_login("xai", Some(stale))?;
        let mode = std::fs::metadata(&auth.path)?.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let fresh = |login: Login| async move {
            let Login::Oauth { refresh, .. } = login else { unreachable!() };
            assert_eq!(refresh, "r1");
            Ok(Login::Oauth {
                access: "new".into(),
                refresh: "r2".into(),
                expires: now_ms() + 60_000,
                account: None,
            })
        };
        assert_eq!(auth.current("xai", fresh).await?.secret(), "new");
        // Now current: the refresh must not run again.
        let again = auth
            .current("xai", |_| async { bail!("refreshed a current token") })
            .await?;
        assert_eq!(again.secret(), "new");
        assert_eq!(auth.get("xai")?, "new");
        assert!(!auth.accepts("xai") && auth.put("xai", "x").is_err());
        auth.put("deploy-key", "s3")?;
        assert_eq!(auth.get("deploy-key")?, "s3");
        auth.set_login("xai", None)?;
        assert!(auth.get("xai").is_err());
        Ok(())
    }
}
