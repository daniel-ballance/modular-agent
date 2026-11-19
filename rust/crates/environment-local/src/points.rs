//! Environment-owned, process-local snapshots. Stage the replacement before touching the project.
use agent_api::*;
use std::{
    collections::BTreeMap,
    fs, io,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Default)]
pub struct Points(Mutex<BTreeMap<String, (String, PathBuf, tempfile::TempDir)>>);

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.is_dir() {
            fs::create_dir(&dest)?;
            copy_tree(&entry.path(), &dest)?;
        } else if meta.is_file() {
            fs::copy(entry.path(), dest)?;
        } else if meta.is_symlink() {
            symlink(fs::read_link(entry.path())?, dest)?;
        } else {
            bail!("cannot snapshot special file {}", entry.path().display());
        }
    }
    fs::set_permissions(to, fs::metadata(from)?.permissions())?;
    Ok(())
}

impl Points {
    pub fn save(&self, session: &str, project: &Path, state: &Path) -> Result<String> {
        let project = project.canonicalize()?;
        ensure!(
            project.parent().is_some(),
            "cannot snapshot the filesystem root"
        );
        ensure!(
            !state.canonicalize()?.starts_with(&project),
            "environment state is inside the project"
        );
        let point = id();
        let snapshot = tempfile::tempdir()?;
        ensure!(
            !snapshot.path().canonicalize()?.starts_with(&project),
            "snapshot folder is inside the project"
        );
        let tree = snapshot.path().join("tree");
        fs::create_dir(&tree)?;
        copy_tree(&project, &tree)?;
        self.0
            .lock()
            .unwrap()
            .insert(point.clone(), (session.into(), project, snapshot));
        Ok(point)
    }

    pub fn check(&self, session: &str, project: &Path, point: &str) -> Result<bool> {
        let project = project.canonicalize()?;
        let points = self.0.lock().unwrap();
        let Some((_, _, saved)) = points
            .get(point)
            .filter(|(owner, root, _)| owner == session && root == &project)
        else {
            return Ok(false);
        };
        match fs::metadata(saved.path().join("tree")) {
            Ok(meta) => Ok(meta.is_dir()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub fn restore(&self, session: &str, project: &Path, point: &str) -> Result<()> {
        let project = project.canonicalize()?;
        let points = self.0.lock().unwrap();
        let (_, _, snapshot) = points
            .get(point)
            .filter(|(owner, root, _)| owner == session && root == &project)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown environment point"))?;
        let parent = project
            .parent()
            .ok_or_else(|| anyhow!("cannot restore the filesystem root"))?;
        let stage = tempfile::tempdir_in(parent)?;
        let tree = stage.path().join("tree");
        fs::create_dir(&tree)?;
        copy_tree(&snapshot.path().join("tree"), &tree)?;
        // Keep the project directory itself. The ACP connection and plugins may
        // have it as their current directory.
        let backup = stage.path().join("previous");
        fs::create_dir(&backup)?;
        let files = |path: &Path| {
            fs::read_dir(path)?
                .map(|e| e.map(|e| e.file_name()))
                .collect::<io::Result<Vec<_>>>()
        };
        let plan = files(&project)?
            .into_iter()
            .map(|name| (project.join(&name), backup.join(name)))
            .chain(
                files(&tree)?
                    .into_iter()
                    .map(|name| (tree.join(&name), project.join(name))),
            )
            .collect::<Vec<_>>();
        for (i, (from, to)) in plan.iter().enumerate() {
            if let Err(error) = fs::rename(from, to) {
                for (from, to) in plan[..i].iter().rev() {
                    if let Err(rollback) = fs::rename(to, from) {
                        let recovery = stage.keep();
                        bail!(
                            "restore failed: {error}; rollback failed: {rollback}; backup at {}",
                            recovery.display()
                        );
                    }
                }
                return Err(error.into());
            }
        }
        Ok(())
    }
}
