use std::process::Command;

pub fn git_project() -> tempfile::TempDir {
    let project = tempfile::tempdir().unwrap();
    let status = Command::new("git")
        .args(["init", "-q"])
        .arg(project.path())
        .status()
        .unwrap();
    assert!(status.success(), "git init failed: {status}");
    project
}
