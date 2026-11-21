use serde_json::{Value, json};
use std::{path::Path, process::Command};

fn ma(dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ma"));
    command
        .current_dir(dir)
        .env("MODULAR_AGENT_DATA_DIR", dir.join("data"))
        .env("MODULAR_AGENT_CONFORMANCE", "1")
        .env_remove("MODULAR_AGENT_ACTOR");
    command
}

#[test]
fn operator_policy_sets_counts_and_defaults_in_the_declaration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("operator.json");
    std::fs::write(
        &path,
        json!({"limits":{"session":{"inputs":2},"agent":{"calls":5}}}).to_string(),
    )
    .unwrap();
    let output = ma(dir.path())
        .arg("--policy")
        .arg(path)
        .arg("--declaration")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let declaration: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        declaration["resourceReservations"]["session"],
        json!({"inputs":2,"calls":64,"jobs":16})
    );
    assert_eq!(declaration["resourceReservations"]["agent"]["calls"], 5);
    assert_eq!(
        declaration["limits"]["session"]["bufferedBytes"],
        16 * 1024 * 1024
    );
    assert_eq!(
        declaration["limits"]["tenant"]["controlBytes"],
        32 * 1024 * 1024
    );
}

#[test]
fn invalid_or_missing_explicit_policy_fails_startup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("operator.json");
    let fail = |message: &str| {
        let result = ma(dir.path())
            .arg("--policy")
            .arg(&path)
            .arg("--declaration")
            .output()
            .unwrap();
        assert!(!result.status.success());
        let stderr = String::from_utf8(result.stderr).unwrap();
        assert!(
            stderr.contains("operator.json") && stderr.contains(message),
            "{stderr}"
        );
    };
    fail("No such file");
    std::fs::write(
        &path,
        json!({"limits":{"session":{"storageBytes":10,"controlBytes":11}}}).to_string(),
    )
    .unwrap();
    fail("controlBytes exceeds storageBytes");
    std::fs::write(&path, json!({"stdio":{"actor":{"id":"editor","kind":"host","rights":["watch"]},"represents":["guest"]}}).to_string()).unwrap();
    fail("does not support representation");
}
