//! Settings files and the separate, explicit project trust ledger.
use crate::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct FilesConfiguration {
    pub global: PathBuf,
    pub defaults: Option<Value>,
}

impl FilesConfiguration {
    pub fn new(global: impl Into<PathBuf>) -> Self {
        Self {
            global: global.into(),
            defaults: None,
        }
    }

    pub fn settings(&self, project: &Path) -> Result<Value> {
        use agent_api::Configuration;
        Ok(self.base().settings(project)?)
    }

    pub fn trusted(&self, project: &Path) -> Result<bool> {
        Ok(self.base().trusted(project)?)
    }

    pub fn trust(&self, project: &Path) -> Result<()> {
        Ok(self.base().trust(project)?)
    }

    pub(crate) fn base(&self) -> config_files::FilesConfiguration {
        config_files::FilesConfiguration {
            global: self.global.clone(),
            defaults: self.defaults.clone(),
        }
    }
}
