//! Independent commit manifest. Persist the intended digest before replacing a
//! local file: an interrupted commit may quarantine the store, never bless a
//! rollback. The store lock covers the comparison and both writes.
use super::*;
use erasure::unavailable;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const REGISTRY: &str = ".erasure/intents";
const IDENTITY: &str = ".erasure/restore-id";

pub(super) struct Witness(PathBuf);

#[derive(Deserialize, Serialize)]
struct Manifest {
    identity: String,
    generation: u64,
    files: BTreeMap<String, String>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl Witness {
    pub(super) fn new(root: &Path, path: &Path) -> Result<Self> {
        let name = path
            .file_name()
            .ok_or_else(|| unavailable("invalid witness path"))?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let path = parent.canonicalize()?.join(name);
        ensure!(
            !path.starts_with(root),
            unavailable("witness is inside history")
        );
        Ok(Self(path))
    }

    pub(super) fn require_unused(&self) -> Result<()> {
        ensure!(
            matches!(fs::symlink_metadata(&self.0), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
            unavailable("witness already exists or is inaccessible")
        );
        Ok(())
    }
}

impl FileHistory {
    pub(super) fn snapshots(&self) -> Result<Vec<PathBuf>> {
        let mut paths = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json") {
                paths.push(path);
            }
        }
        Ok(paths)
    }

    pub(super) fn check_witness(&self, fresh: bool) -> Result<()> {
        let path = self.root.join(REGISTRY);
        ensure!(path.try_exists()?, unavailable("missing registry"));
        let identity = self.root.join(IDENTITY);
        if let Some(witness) = &self.witness {
            if fresh {
                let id = id();
                let manifest = Manifest {
                    identity: id.clone(),
                    generation: 0,
                    files: BTreeMap::from([(REGISTRY.into(), digest(&fs::read(path)?))]),
                };
                // Reserve the external path without overwriting another store's witness.
                OpenOptions::new()
                    .mode(0o600)
                    .write(true)
                    .create_new(true)
                    .open(&witness.0)?;
                self.replace(&witness.0, &serde_json::to_vec(&manifest)?)?;
                self.replace(&identity, id.as_bytes())?;
            } else {
                self.read_tracked(&path)?;
            }
        } else {
            ensure!(
                !identity.try_exists()?,
                unavailable("restore witness required")
            );
        }
        Ok(())
    }

    fn manifest(&self, witness: &Witness) -> Result<Manifest> {
        let meta = fs::symlink_metadata(&witness.0).map_err(unavailable)?;
        ensure!(meta.is_file(), unavailable("invalid restore witness file"));
        let bytes = fs::read(&witness.0).map_err(unavailable)?;
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(unavailable)?;
        ensure!(
            fs::read(self.root.join(IDENTITY)).ok().as_deref()
                == Some(manifest.identity.as_bytes()),
            unavailable("restore witness identity mismatch")
        );
        Ok(manifest)
    }

    fn key<'a>(&self, path: &'a Path) -> Result<&'a str> {
        path.strip_prefix(&self.root)?
            .to_str()
            .ok_or_else(|| unavailable("invalid history path"))
    }

    fn verify(&self, manifest: &Manifest, path: &Path) -> Result<std::io::Result<Vec<u8>>> {
        let bytes = fs::read(path);
        let expected = manifest.files.get(self.key(path)?);
        let matches = match (&bytes, expected) {
            (Ok(bytes), Some(expected)) => digest(bytes) == *expected,
            (Err(e), None) => e.kind() == std::io::ErrorKind::NotFound,
            _ => false,
        };
        ensure!(
            matches,
            unavailable("history does not match restore witness")
        );
        Ok(bytes)
    }

    pub(super) fn read_tracked(&self, path: &Path) -> Result<Vec<u8>> {
        if let Some(witness) = &self.witness {
            Ok(self.verify(&self.manifest(witness)?, path)??)
        } else {
            Ok(fs::read(path)?)
        }
    }

    pub(super) fn verify_snapshots(&self, paths: &[PathBuf]) -> Result<()> {
        if let Some(witness) = &self.witness {
            let manifest = self.manifest(witness)?;
            ensure!(
                manifest.files.len() == paths.len() + 1,
                unavailable("history does not match restore witness")
            );
            for path in paths {
                self.verify(&manifest, path)??;
            }
        }
        Ok(())
    }

    pub(super) fn replace_tracked(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(witness) = &self.witness {
            let mut manifest = self.manifest(witness)?;
            let _ = self.verify(&manifest, path)?;
            manifest.files.insert(self.key(path)?.into(), digest(bytes));
            manifest.generation = manifest
                .generation
                .checked_add(1)
                .ok_or_else(|| unavailable("restore generation exhausted"))?;
            self.replace(&witness.0, &serde_json::to_vec(&manifest)?)
                .map_err(unavailable)?;
        }
        self.replace(path, bytes)
    }
}
