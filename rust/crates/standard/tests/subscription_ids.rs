use serde_json::{Value, json};
use std::{fs, io::Write, os::unix::fs::OpenOptionsExt, process::Command};

#[test]
fn ma_reads_only_the_selected_subscription_slot() {
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ma"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", dir.path())
            .env("MODULAR_AGENT_DATA_DIR", dir.path())
            .current_dir(dir.path())
            .args(args)
            .output()
            .unwrap()
    };
    let write = |name: &str, data: &Value| {
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(dir.path().join(name))
            .unwrap()
            .write_all(&serde_json::to_vec(data).unwrap())
            .unwrap()
    };
    let model = json!({"id":"custom","contextWindow":2000,"maxTokens":1024});
    write("models.json", &json!({"xai":[model],"chatgpt":[model]}));
    let models = run(&["models"]);
    assert!(models.status.success());
    let catalog = String::from_utf8(models.stdout).unwrap();
    assert!(catalog.contains("chatgpt/custom"));
    assert!(!catalog.contains("grok/custom"));

    let unknown = run(&["--model", "xai/grok-4.7", "-p", "offline"]);
    assert!(!unknown.status.success());
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("xai/grok-4.7"));
    let login = json!({"type":"api_key","key":"fixture"});
    let file =
        json!({"logins":{"openai-codex":login,"grok":login},"answers":{"example":"fixture"}});
    write("auth.json", &file);
    let auth = run(&["auth"]);
    assert!(auth.status.success());
    assert!(
        String::from_utf8(auth.stdout)
            .unwrap()
            .lines()
            .any(|s| s.starts_with("chatgpt") && s.contains("not signed in"))
    );
    assert!(!run(&["logout", "openai-codex"]).status.success());
    assert!(run(&["logout", "grok"]).status.success());
    let mut expected = file;
    expected["logins"].as_object_mut().unwrap().remove("grok");
    let actual: Value =
        serde_json::from_slice(&fs::read(dir.path().join("auth.json")).unwrap()).unwrap();
    assert_eq!(actual, expected);
}
