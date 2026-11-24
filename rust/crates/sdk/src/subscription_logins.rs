//! The login file shared by subscription Providers and their callers.
use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions, Permissions},
    io::{BufReader, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[doc(hidden)]
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Login {
    Oauth {
        access: String,
        refresh: String,
        /// Epoch milliseconds, already brought forward by the refresh margin.
        expires: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
    },
    ApiKey {
        key: String,
    },
}
impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Login(<redacted>)")
    }
}
impl Login {
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
#[doc(hidden)]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[doc(hidden)]
#[derive(Default, Serialize, Deserialize)]
pub struct LoginContents {
    #[serde(default)]
    logins: BTreeMap<String, Login>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// A handle to an owner-only JSON login file. Opening a handle performs no I/O.
#[derive(Clone)]
pub struct SubscriptionLogins {
    path: PathBuf,
}

pub fn subscription_logins(path: impl Into<PathBuf>) -> SubscriptionLogins {
    SubscriptionLogins { path: path.into() }
}

impl SubscriptionLogins {
    fn parent(&self) -> &Path {
        self.path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
    }

    #[doc(hidden)]
    pub fn read(&self) -> Result<LoginContents> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LoginContents::default());
            }
            Err(e) => return Err(e.into()),
        };
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "the login file is not a regular file");
        ensure!(
            metadata.permissions().mode() & 0o044 == 0,
            "the login file is readable by others; set its mode to 0600"
        );
        serde_json::from_reader(BufReader::new(file))
            .map_err(|_| anyhow!("the login file is not valid JSON or has an invalid login"))
    }

    fn write(&self, contents: &LoginContents) -> Result<()> {
        let parent = self.parent();
        (|| -> Result<()> {
            let mut temporary = tempfile::Builder::new()
                .prefix(".auth-")
                .tempfile_in(parent)?;
            temporary
                .as_file()
                .set_permissions(Permissions::from_mode(0o600))?;
            temporary.write_all(&serde_json::to_vec_pretty(contents)?)?;
            temporary.as_file().sync_all()?;
            temporary.persist(&self.path)?;
            File::open(parent)?.sync_all()?;
            Ok(())
        })()
        .map_err(|_| anyhow!("the login file could not be written"))
    }

    fn lock(&self) -> Result<File> {
        std::fs::create_dir_all(self.parent())?;
        let path = self.path.with_extension("lock");
        ensure!(
            path != self.path,
            "the login file must not have the .lock extension"
        );
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)?;
        fs2::FileExt::lock_exclusive(&file)?;
        // Closing this descriptor releases its flock, even on cancellation.
        Ok(file)
    }

    #[doc(hidden)]
    pub fn update<T>(&self, change: impl FnOnce(&mut LoginContents) -> Result<T>) -> Result<T> {
        let _lock = self.lock()?;
        let mut contents = self.read()?;
        let result = change(&mut contents)?;
        self.write(&contents)?;
        Ok(result)
    }

    #[doc(hidden)]
    pub fn login(&self, provider: &str) -> Result<Option<Login>> {
        Ok(self.read()?.logins.remove(provider))
    }

    #[doc(hidden)]
    pub fn set_login(&self, provider: &str, login: Option<Login>) -> Result<()> {
        self.update(|contents| {
            if let Some(login) = login {
                contents.logins.insert(provider.into(), login);
            } else {
                contents.logins.remove(provider);
            }
            Ok(())
        })
    }

    /// Check again under the lock before spending a refresh token. A failed
    /// refresh leaves the file untouched.
    #[doc(hidden)]
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
        let missing = || anyhow!("not signed in to {provider}");
        let login = self.login(provider)?.ok_or_else(missing)?;
        if !needs_refresh(&login) {
            return Ok(login);
        }
        let this = self.clone();
        let _lock = tokio::task::spawn_blocking(move || this.lock()).await??;
        let mut contents = self.read()?;
        let login = contents.logins.get(provider).ok_or_else(missing)?.clone();
        if !needs_refresh(&login) {
            return Ok(login);
        }
        let fresh = refresh(login).await?;
        contents.logins.insert(provider.into(), fresh.clone());
        self.write(&contents)?;
        Ok(fresh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_other_members_and_refuses_public_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let original = br#"{"logins":{},"answers":{"name":"fixture"},"unrecognized":[1,true]}"#;
        std::fs::write(&path, original).unwrap();
        let logins = subscription_logins(&path);
        let set_mode =
            |mode| std::fs::set_permissions(&path, Permissions::from_mode(mode)).unwrap();
        set_mode(0o640);
        assert!(
            logins
                .login("chatgpt")
                .unwrap_err()
                .to_string()
                .contains("readable by others")
        );
        assert!(logins.set_login("chatgpt", None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        set_mode(0o600);
        logins.set_login("chatgpt", None).unwrap();
        let next: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(next["answers"]["name"], "fixture");
        assert_eq!(next["unrecognized"], serde_json::json!([1, true]));
        for path in [path, dir.path().join("auth.lock")] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
