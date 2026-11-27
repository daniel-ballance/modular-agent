use std::process::Command;

#[test]
fn serve_plugin_rejects_host_policy() {
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_modular-agent"))
        .args(["--serve-plugin", "--listen", "127.0.0.1:0", "--host-policy"])
        .arg(dir.path().join("policy.json"))
        .env_remove("MODULAR_AGENT_PLUGIN_PARTS")
        .env_remove("MODULAR_AGENT_PLUGIN_PROJECT")
        .env_remove("MODULAR_AGENT_PLUGIN_STATE_DIR")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr).trim_end(),
        "Error: usage: --serve-plugin [--listen ADDR --token-file FILE]"
    );
}
