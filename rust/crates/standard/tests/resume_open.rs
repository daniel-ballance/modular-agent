#[cfg(target_os = "linux")]
#[path = "resume_open/crash.rs"]
mod crash;

use serde_json::json;
use std::process::Command;

#[test]
fn resume_open_is_not_a_session_setting_or_a_print_mode_action() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let project = dir.path().join("project");
    let config = dir.path().join("global");
    std::fs::create_dir(&project)?;
    std::fs::create_dir(&config)?;
    std::fs::write(config.join("settings.json"), r#"{"resume_open":true}"#)?;
    std::fs::write(
        project.join(".modular-agent.json"),
        r#"{"resume_open":false}"#,
    )?;
    let script = dir.path().join("script.json");
    std::fs::write(&script, json!([{"text":"printed"}]).to_string())?;
    let output = Command::new(env!("CARGO_BIN_EXE_ma"))
        .current_dir(&project)
        .env("MODULAR_AGENT_DATA_DIR", &config)
        .env("MODULAR_AGENT_SCRIPT", script)
        .env_remove("MODULAR_AGENT_HISTORY_URL")
        .args(["--resume-open", "-p", "hello"])
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8(output.stdout)?.trim(), "printed");
    let settings =
        modular_agent::FilesConfiguration::new(config.join("settings.json")).settings(&project)?;
    assert!(settings.get("resume_open").is_none());
    Ok(())
}
