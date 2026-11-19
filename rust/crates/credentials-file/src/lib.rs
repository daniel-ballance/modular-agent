use agent_api::*;
use std::{path::PathBuf, sync::Arc};
/// Paths, never values, are configured. The credential is read only at request time.
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
impl CredentialStore for FileCredentials {
    fn get(&self, name: &str) -> Result<String> {
        let path = if name == "openai" {
            self.openai_key.clone()
        } else {
            self.named(name)?
        };
        let value = std::fs::read_to_string(path)
            .map_err(|_| anyhow!("OpenAI credential file unavailable"))?;
        let value = if name == "openai" {
            value.trim().to_string()
        } else {
            value
        };
        ensure!(
            name != "openai" || !value.is_empty(),
            "OpenAI credential file empty"
        );
        Ok(value)
    }
    fn accepts(&self, name: &str) -> bool {
        name != "openai" && self.named(name).is_ok()
    }
    fn writable(&self) -> bool {
        true
    }
    fn put(&self, name: &str, value: &str) -> Result<()> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        ensure!(
            name != "openai",
            "provider credential cannot be replaced by an answer"
        );
        let path = self.named(name)?;
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        let temp = parent.join(id());
        let result: Result<()> = (|| {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)?;
            file.write_all(value.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temp, &path)?;
            std::fs::File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result.map_err(|_| anyhow!("credential could not be stored"))
    }
}
impl FileCredentials {
    fn named(&self, name: &str) -> Result<PathBuf> {
        ensure!(
            !name.is_empty()
                && name.len() <= 128
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "invalid credential name"
        );
        Ok(self.openai_key.with_file_name("answers").join(name))
    }
}
