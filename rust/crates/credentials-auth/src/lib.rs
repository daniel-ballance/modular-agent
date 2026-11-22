//! The standard configuration's named credentials and staging journal in the
//! same file that the SDK uses for subscription logins.
use anyhow::{Result, anyhow, ensure};
use modular_agent::{LoginContents, SecretJournal, SubscriptionLogins, subscription_logins};
use std::{collections::BTreeMap, path::PathBuf};

pub use modular_agent::{Login, now_ms};

#[derive(Clone)]
pub struct AuthFile {
    pub path: PathBuf,
    /// Names that are Provider sign-ins, never the target of a secret answer.
    pub providers: Vec<String>,
    logins: SubscriptionLogins,
}

type Answers = BTreeMap<String, String>;

fn member<T: serde::de::DeserializeOwned + Default>(
    contents: &LoginContents,
    name: &str,
) -> Result<T> {
    contents.extra.get(name).map_or_else(
        || Ok(T::default()),
        |v| {
            serde_json::from_value(v.clone())
                .map_err(|_| anyhow!("invalid {name} in the credential file"))
        },
    )
}

impl AuthFile {
    pub fn new(path: PathBuf, providers: &[&str]) -> Self {
        let logins = subscription_logins(&path);
        Self {
            path,
            logins,
            providers: providers.iter().map(|p| p.to_string()).collect(),
        }
    }

    pub fn subscription_logins(&self) -> SubscriptionLogins {
        self.logins.clone()
    }

    pub fn login(&self, provider: &str) -> Result<Option<Login>> {
        self.logins.login(provider)
    }

    pub fn set_login(&self, provider: &str, login: Option<Login>) -> Result<()> {
        self.logins.set_login(provider, login)
    }

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
        self.logins.current(provider, rejected, refresh).await
    }

    fn change<T>(
        &self,
        change: impl FnOnce(&mut SecretJournal, &mut Answers) -> Result<T>,
    ) -> Result<T> {
        self.logins.update(|contents| {
            let mut staging = member::<SecretJournal>(contents, "staging")?;
            let mut answers = member::<Answers>(contents, "answers")?;
            let result = change(&mut staging, &mut answers)?;
            contents
                .extra
                .insert("answers".into(), serde_json::to_value(answers)?);
            if staging.is_empty() {
                contents.extra.remove("staging");
            } else {
                contents
                    .extra
                    .insert("staging".into(), serde_json::to_value(staging)?);
            }
            Ok(result)
        })
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

    pub fn answer(&self, name: &str) -> Result<String> {
        self.answer_name(name)?;
        member::<Answers>(&self.logins.read()?, "answers")?
            .remove(name)
            .ok_or_else(|| anyhow!("no credential named {name}"))
    }

    pub fn accepts(&self, name: &str) -> bool {
        self.answer_name(name).is_ok()
    }

    pub fn put_answer(&self, name: &str, value: &str) -> Result<()> {
        self.answer_name(name)?;
        self.change(|staging, answers| Ok(staging.replace(answers, name, Some(value.into()))?))
    }
}

impl modular_agent::CredentialStore for AuthFile {
    fn read(&self, name: &str) -> modular_agent::Result<String> {
        Ok(self.answer(name)?)
    }
    fn read_provider(&self, provider: &str) -> modular_agent::Result<String> {
        self.login(provider)?
            .map(|login| login.secret().to_owned())
            .ok_or_else(|| {
                modular_agent::Error::new(
                    modular_agent::Code::NotFound,
                    format!("not signed in to {provider}"),
                )
            })
    }
    fn write(&self, name: &str, value: &str) -> modular_agent::Result<()> {
        Ok(self.put_answer(name, value)?)
    }
    fn stage(
        &self,
        receipt: modular_agent::StagingReceipt,
        value: &str,
    ) -> modular_agent::Result<()> {
        self.answer_name(&receipt.name)?;
        Ok(self.change(|staging, _| Ok(staging.stage(receipt, value)?))?)
    }
    fn lookup_staged(
        &self,
        request: &modular_agent::SecretRequest,
    ) -> modular_agent::Result<Option<modular_agent::StagingReceipt>> {
        Ok(member::<SecretJournal>(&self.logins.read()?, "staging")?.lookup(request))
    }
    fn activate(
        &self,
        request: &modular_agent::SecretRequest,
    ) -> modular_agent::Result<modular_agent::Activation> {
        Ok(self.change(|staging, answers| Ok(staging.activate(request, answers)?))?)
    }
    fn discard(&self, request: &modular_agent::SecretRequest) -> modular_agent::Result<()> {
        Ok(self.change(|staging, _| {
            staging.discard(request);
            Ok(())
        })?)
    }
    fn writable(&self) -> bool {
        true
    }
    fn accepts(&self, name: &str) -> bool {
        self.accepts(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
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
        std::fs::set_permissions(&auth.path, std::fs::Permissions::from_mode(0o600)).unwrap();
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
        let other = AuthFile::new(auth.path.clone(), &["xai"]);
        let b = other.current("xai", Some("before"), refresh);
        let (a, b) = tokio::join!(a, b);
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(observed.load(Ordering::SeqCst), 1);
        assert!(dir.path().join("auth.lock").is_file());
    }
}
