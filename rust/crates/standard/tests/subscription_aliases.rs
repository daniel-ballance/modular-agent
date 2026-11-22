//! ma accepts the old Provider ids without contacting either vendor.
use modular_agent::{
    Agent, AssistantMessage, Durability, ModelInfo, ModelRef, ModelRequest, Provider,
    ProviderContext, async_trait,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process::{Command, Output},
};

struct Rig {
    root: tempfile::TempDir,
    home: PathBuf,
    project: PathBuf,
    data: PathBuf,
}
impl Rig {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("project");
        let data = root.path().join("data");
        for path in [&home, &project, &data] {
            fs::create_dir(path).unwrap();
        }
        Self {
            root,
            home,
            project,
            data,
        }
    }
    fn command(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_ma"))
            .args(args)
            .current_dir(&self.project)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", &self.home)
            .env("TMPDIR", self.root.path())
            .env("MODULAR_AGENT_DATA_DIR", &self.data)
            .env(
                "MODULAR_AGENT_CLAUDE_SIDECAR",
                self.root.path().join("no-program"),
            )
            .env("MA_NO_BROWSER", "1")
            .output()
            .unwrap()
    }
    fn ok(&self, args: &[&str]) -> Output {
        let out = self.command(args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }
    fn sessions(&self) -> Vec<Value> {
        serde_json::from_slice(&self.ok(&["sessions"]).stdout).unwrap()
    }
    fn write(&self, name: &str, value: Value) {
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(self.data.join(name))
            .unwrap()
            .write_all(&serde_json::to_vec(&value).unwrap())
            .unwrap();
    }
    fn assert_stored_model(&self, model: &str, args: &[&str]) {
        let out = self.command(args);
        assert_eq!(
            out.status.code(),
            Some(1),
            "unsigned Provider must stop the turn"
        );
        assert!(String::from_utf8_lossy(&out.stderr).contains("turn failed"));
        assert!(self.sessions().iter().any(|s| s["model"] == model));
    }
}

#[test]
fn model_flag_and_settings_accept_both_old_provider_ids() {
    for (old, canonical) in [
        ("openai-codex/gpt-6.1-sol", "chatgpt/gpt-6.1-sol"),
        ("xai/grok-4.7", "grok/grok-4.7"),
    ] {
        Rig::new().assert_stored_model(canonical, &["--model", old, "-p", "offline"]);
        let rig = Rig::new();
        rig.write("settings.json", json!({"model":old}));
        rig.assert_stored_model(canonical, &["-p", "offline"]);
    }
}

#[test]
fn models_json_accepts_old_keys_and_prefers_canonical_replacements() {
    let rig = Rig::new();
    let model = |id, size| json!({"id":id,"contextWindow":size,"maxTokens":1024});
    rig.write(
        "models.json",
        json!({
            "openai-codex":[model("old-only", 1000), model("both", 1000)],
            "chatgpt":[model("both", 2000)],
            "xai":[model("grok-custom", 3000)]
        }),
    );
    let list = String::from_utf8(rig.ok(&["models"]).stdout).unwrap();
    for (id, size) in [
        ("chatgpt/old-only", "1000"),
        ("chatgpt/both", "2000"),
        ("grok/grok-custom", "3000"),
    ] {
        assert!(
            list.lines()
                .any(|line| line.starts_with(id) && line.contains(size)),
            "{list}"
        );
    }
    assert!(!list.contains("openai-codex/") && !list.contains("xai/"));
}

#[test]
fn alias_logout_migrates_other_logins_and_preserves_answers() {
    let rig = Rig::new();
    let login = json!({"type":"oauth","access":"fixture","refresh":"fixture","expires":0});
    rig.write("auth.json", json!({"logins":{"openai-codex":login,"xai":login},"answers":{"dummy":"fixture"},"other":17}));
    let state = String::from_utf8(rig.ok(&["auth"]).stdout).unwrap();
    assert!(
        state
            .lines()
            .any(|line| line.starts_with("chatgpt") && line.contains("token will refresh"))
    );
    assert!(
        state
            .lines()
            .any(|line| line.starts_with("grok") && line.contains("token will refresh"))
    );
    rig.ok(&["logout", "openai-codex"]);
    let read =
        || serde_json::from_slice::<Value>(&fs::read(rig.data.join("auth.json")).unwrap()).unwrap();
    assert_eq!(
        read(),
        json!({"logins":{"grok":login},"answers":{"dummy":"fixture"},"other":17})
    );
    rig.ok(&["logout", "xai"]);
    assert_eq!(
        read(),
        json!({"logins":{},"answers":{"dummy":"fixture"},"other":17})
    );
}

struct OldProvider {
    provider_id: String,
    model_id: String,
}

#[async_trait]
impl Provider for OldProvider {
    fn id(&self) -> &str {
        &self.provider_id
    }
    fn models(&self) -> Vec<ModelInfo> {
        vec![ModelInfo {
            model: ModelRef {
                provider: self.provider_id.clone(),
                id: self.model_id.clone(),
            },
            context_window: 32_000,
            max_output: 1024,
            thinking: vec![],
            extra: Default::default(),
        }]
    }
    async fn request(
        &self,
        _: ModelRef,
        _: ModelRequest,
        _: ProviderContext,
    ) -> modular_agent::Result<AssistantMessage> {
        Ok(AssistantMessage::text("fixture"))
    }
}

#[tokio::test]
async fn ma_reopens_native_sessions_saved_with_old_provider_ids() -> modular_agent::Result<()> {
    for (old, canonical) in [
        ("openai-codex/gpt-6.1-sol", "chatgpt/gpt-6.1-sol"),
        ("xai/grok-4.7", "grok/grok-4.7"),
    ] {
        let rig = Rig::new();
        let state = rig.data.join("state");
        let writer = Agent::builder()
            .project(&rig.project)
            .data_dir(&state)
            .durability(Durability::Kept)
            .provider({
                let (provider, id) = old.split_once('/').unwrap();
                OldProvider {
                    provider_id: provider.into(),
                    model_id: id.into(),
                }
            })
            .model(old)
            .build()
            .await?;
        let session = writer.session().await?;
        assert_eq!(session.prompt("save this fixture").await?.text, "fixture");
        let id = session.id().to_owned();
        writer.close().await?;
        assert_eq!(rig.sessions()[0]["model"], old);
        let out = rig.command(&["--session", &id, "--json", "-p", "offline"]);
        assert_eq!(out.status.code(), Some(1));
        let events = String::from_utf8_lossy(&out.stdout);
        assert!(
            events.contains("Provider is unavailable"),
            "{canonical}: {events}"
        );
        // Selection is normalized without rewriting the old setting record.
        assert_eq!(rig.sessions()[0]["model"], old);
    }
    Ok(())
}
