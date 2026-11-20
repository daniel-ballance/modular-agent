//! A local credential store. The SDK checks Provider ownership before calling it.
use crate::{Code, Error, Result};
pub use agent_api::{Activation, SecretJournal, SecretRequest, StagingReceipt};
use std::sync::Arc;

pub trait CredentialStore: Send + Sync + 'static {
    /// A named, non-Provider credential.
    fn read(&self, name: &str) -> Result<String>;

    /// The credential for an authenticated Provider, never a user-supplied name.
    fn read_provider(&self, provider: &str) -> Result<String> {
        self.read(provider)
    }

    fn write(&self, _name: &str, _value: &str) -> Result<()> {
        Err(Error::new(
            Code::NotSupported,
            "credential store is read-only",
        ))
    }

    fn stage(&self, _receipt: StagingReceipt, _value: &str) -> Result<()> {
        Err(Error::new(
            Code::NotSupported,
            "credential staging is not supported",
        ))
    }
    fn lookup_staged(&self, _request: &SecretRequest) -> Result<Option<StagingReceipt>> {
        Ok(None)
    }
    fn activate(&self, _request: &SecretRequest) -> Result<Activation> {
        Err(Error::new(
            Code::NotSupported,
            "credential staging is not supported",
        ))
    }
    fn discard(&self, _request: &SecretRequest) -> Result<()> {
        Ok(())
    }

    fn writable(&self) -> bool {
        false
    }
    fn accepts(&self, _name: &str) -> bool {
        self.writable()
    }
}

pub(crate) struct StoreAdapter(pub Arc<dyn CredentialStore>);
impl agent_api::CredentialStore for StoreAdapter {
    fn get(&self, name: &str) -> agent_api::Result<String> {
        Ok(self.0.read(name)?)
    }
    fn provider(
        &self,
        claim: &agent_api::CredentialClaim,
        name: &str,
    ) -> agent_api::Result<String> {
        agent_api::ensure!(claim.covers(name), "Provider did not claim {name}");
        Ok(self.0.read_provider(name)?)
    }
    fn put(&self, name: &str, value: &str) -> agent_api::Result<()> {
        Ok(self.0.write(name, value)?)
    }
    fn writable(&self) -> bool {
        self.0.writable()
    }
    fn accepts(&self, name: &str) -> bool {
        self.0.accepts(name)
    }
    fn stage(&self, receipt: StagingReceipt, value: &str) -> agent_api::Result<()> {
        Ok(self.0.stage(receipt, value)?)
    }
    fn lookup_staged(&self, request: &SecretRequest) -> agent_api::Result<Option<StagingReceipt>> {
        Ok(self.0.lookup_staged(request)?)
    }
    fn activate(&self, request: &SecretRequest) -> agent_api::Result<Activation> {
        Ok(self.0.activate(request)?)
    }
    fn discard(&self, request: &SecretRequest) -> agent_api::Result<()> {
        Ok(self.0.discard(request)?)
    }
}

pub fn file_credentials(path: impl Into<std::path::PathBuf>) -> impl CredentialStore {
    FileStore(credentials_file::SecretFile(path.into()))
}

struct FileStore(credentials_file::SecretFile);
impl CredentialStore for FileStore {
    fn read(&self, name: &str) -> Result<String> {
        Ok(self.0.read(name)?)
    }
    fn write(&self, name: &str, value: &str) -> Result<()> {
        Ok(self.0.write(name, value)?)
    }
    fn writable(&self) -> bool {
        true
    }
    fn accepts(&self, name: &str) -> bool {
        credentials_file::valid_name(name)
    }
    fn stage(&self, receipt: StagingReceipt, value: &str) -> Result<()> {
        Ok(self.0.stage(receipt, value)?)
    }
    fn lookup_staged(&self, request: &SecretRequest) -> Result<Option<StagingReceipt>> {
        Ok(self.0.lookup(request)?)
    }
    fn activate(&self, request: &SecretRequest) -> Result<Activation> {
        Ok(self.0.activate(request)?)
    }
    fn discard(&self, request: &SecretRequest) -> Result<()> {
        Ok(self.0.discard(request)?)
    }
}

/// Credentials from environment variables, by the names each Provider documents.
pub fn environment_credentials() -> impl CredentialStore {
    EnvironmentCredentials
}

struct EnvironmentCredentials;
impl CredentialStore for EnvironmentCredentials {
    fn read(&self, name: &str) -> Result<String> {
        let key = name.to_ascii_uppercase().replace('-', "_") + "_API_KEY";
        std::env::var(&key).map_err(|_| {
            Error::new(
                Code::NotFound,
                format!("credential {key} is not set in the environment"),
            )
        })
    }
}
