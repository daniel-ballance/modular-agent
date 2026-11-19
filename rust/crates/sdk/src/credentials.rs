//! A local credential store. The SDK checks Provider ownership before calling it.
use crate::{Code, Error, Result};
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
}
