use std::{ffi::OsString, os::unix::ffi::OsStringExt, process::Command};

#[test]
fn invalid_identity_is_rejected_before_loading_configuration() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing-script.json");
    for identity in [
        OsString::from(""),
        OsString::from("bad identity!"),
        OsString::from("x".repeat(65)),
        OsString::from_vec(vec![0xff]),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_ma"))
            .env("MA_CLIENT_IDENTITY", &identity)
            .env("MODULAR_AGENT_SCRIPT", &missing)
            .env_remove("HOME")
            .arg("--help")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{identity:?}");
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("MA_CLIENT_IDENTITY"), "{stderr}");
        assert!(output.stdout.is_empty());
    }
}
