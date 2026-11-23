use anyhow::{Result, ensure};
use modular_agent::{
    Agent, Durability, History, Outcome, file_history, testing::scripted_provider,
};
use serde_json::{Value, json};
use std::{fs, io, os::unix::fs::PermissionsExt, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};

const TOKEN: &str = "disposable-startup-test-token";
struct Rig {
    root: tempfile::TempDir,
    project: PathBuf,
    config: PathBuf,
    history: History,
}

impl Rig {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let project = root.path().join("work");
        let config = root.path().join("config");
        fs::create_dir(&project)?;
        let history = file_history(config.join("state/sessions"))?;
        fs::write(root.path().join("token"), TOKEN)?;
        fs::set_permissions(root.path().join("token"), fs::Permissions::from_mode(0o600))?;
        fs::write(root.path().join("script"), json!([
            {"toolCalls":[{"name":"codemode","input":{"code":"tools.exec('echo effect >> count; exec sleep 30')"}}]},
            {"text":"Recovered."}
        ]).to_string())?;
        Ok(Self {
            root,
            project,
            config,
            history,
        })
    }
    fn ma(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_ma"));
        cmd.current_dir(&self.project)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .env("MODULAR_AGENT_DATA_DIR", &self.config)
            .env("MODULAR_AGENT_SCRIPT", self.root.path().join("script"))
            .env(
                "MODULAR_AGENT_SCRIPT_LOG",
                self.root.path().join("requests"),
            )
            .env_remove("MODULAR_AGENT_HISTORY_URL")
            .env_remove("MODULAR_AGENT_ACTOR");
        cmd
    }
    async fn listener(&self, opts: &[&str], log: &str) -> Result<(Child, String)> {
        let log = self.root.path().join(log);
        let mut child = self
            .ma()
            .args(["--agui", "--listen", "127.0.0.1:0", "--token-file"])
            .arg(self.root.path().join("token"))
            .args(opts)
            .stdout(Stdio::piped())
            .stderr(fs::File::create(&log)?)
            .spawn()?;
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut url = String::new();
        tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut url)).await??;
        ensure!(
            url.starts_with("http://"),
            "listener failed: {}",
            fs::read_to_string(&log)?
        );
        Ok((child, url.trim_end().into()))
    }
    async fn live_writer(&self) -> Result<(Child, String, reqwest::Response)> {
        let (child, url) = self.listener(&[], "first").await?;
        let client = reqwest::Client::new();
        let created: Value = client
            .post(format!("{url}/agui/v1/threads"))
            .bearer_auth(TOKEN)
            .json(&json!({}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let id = created["threadId"].as_str().unwrap();
        let stream = client
            .post(format!("{url}/agui/v1/run"))
            .bearer_auth(TOKEN)
            .json(
                &json!({"protocolVersion":"1.0","threadId":id,"runId":"first",
                "messages":[{"id":"local","role":"user","content":"private prompt"}]}),
            )
            .send()
            .await?
            .error_for_status()?;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match fs::read_to_string(self.project.join("count")) {
                    Ok(s) if s == "effect\n" => return Ok::<_, io::Error>(()),
                    Ok(_) => (),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e),
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await??;
        assert!(self.history.session_info(id)?.unfinished_turn);
        Ok((child, id.into(), stream))
    }
    async fn assert_end(&self, id: &str, expected: &str) -> Result<()> {
        // Observe the metadata before the test opens anything. Another open
        // must not be the reason the interrupted turn completed.
        assert!(!self.history.session_info(id)?.unfinished_turn);
        assert_eq!(fs::read_to_string(self.project.join("count"))?, "effect\n");
        let reader = Agent::builder()
            .project(&self.project)
            .data_dir(self.config.join("state"))
            .history(self.history.clone())
            .durability(Durability::Kept)
            .provider(scripted_provider(json!([])))
            .build()
            .await?;
        let s = reader.open_session(id).await?;
        let rows = s.history().await?;
        assert_eq!(rows.iter().filter(|e| e["kind"] == "turnStart").count(), 1);
        assert_eq!(rows.iter().filter(|e| e["kind"] == "turnEnd").count(), 1);
        assert_eq!(
            s.last_turn()
                .await?
                .unwrap()
                .outcome
                .as_ref()
                .map(Outcome::kind),
            Some(expected)
        );
        reader.close().await?;
        Ok(())
    }
}

#[tokio::test]
async fn held_then_interrupted_turn_resumes_once_without_a_client() -> Result<()> {
    let r = Rig::new()?;
    let (mut writer, id, stream) = r.live_writer().await?;
    let (mut other, _) = r.listener(&["--resume-open"], "held").await?;
    let log = fs::read_to_string(r.root.path().join("held"))?;
    assert!(
        log.lines()
            .any(|l| l == format!("resume-open: skipped {id} (busy)")),
        "{log}"
    );
    other.kill().await?;
    writer.kill().await?;
    drop(stream);

    fs::write(
        r.project.join(".modular-agent.json"),
        r#"{"resume_open":true}"#,
    )?;
    let (mut off, _) = r.listener(&[], "off").await?;
    assert!(r.history.session_info(&id)?.unfinished_turn);
    assert!(!fs::read_to_string(r.root.path().join("off"))?.contains("resume-open:"));
    off.kill().await?;

    fs::write(r.config.join("settings.json"), r#"{"resume_open":true}"#)?;
    fs::write(
        r.project.join(".modular-agent.json"),
        r#"{"resume_open":false}"#,
    )?;
    let (mut on, _) = r.listener(&[], "resumed").await?;
    let log = fs::read_to_string(r.root.path().join("resumed"))?;
    assert_eq!(
        log.lines()
            .filter(|l| l.starts_with("resume-open:"))
            .collect::<Vec<_>>(),
        [format!("resume-open: resumed {id}")]
    );
    assert_eq!(
        fs::read_to_string(r.root.path().join("requests"))?
            .lines()
            .count(),
        2
    );
    on.kill().await?;
    r.assert_end(&id, "completed").await
}

#[tokio::test]
async fn transient_acp_startup_ends_the_interrupted_turn_as_failed() -> Result<()> {
    let r = Rig::new()?;
    let (mut writer, id, stream) = r.live_writer().await?;
    writer.kill().await?;
    drop(stream);
    // EOF, without initialize or a client open.
    let acp = r
        .ma()
        .args(["--acp", "--resume-open", "--runtime", "transient"])
        .output()
        .await?;
    let log = String::from_utf8(acp.stderr)?;
    assert!(acp.status.success(), "{log}");
    assert!(
        log.lines()
            .any(|l| l == format!("resume-open: resumed {id}")),
        "{log}"
    );
    assert_eq!(
        fs::read_to_string(r.root.path().join("requests"))?
            .lines()
            .count(),
        1
    );
    r.assert_end(&id, "failed").await
}
