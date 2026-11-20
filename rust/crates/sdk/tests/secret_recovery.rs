use modular_agent::testing::scripted_provider;
use modular_agent::{
    Activation, Agent, Answer, CredentialStore, Durability, Result, SecretRequest, StagingReceipt,
    Timing, file_credentials,
};
use serde_json::json;
use std::{path::Path, time::Duration};

struct CrashStore<S> {
    store: S,
    boundary: String,
}
impl<S: CredentialStore> CredentialStore for CrashStore<S> {
    fn read(&self, name: &str) -> Result<String> {
        self.store.read(name)
    }
    fn writable(&self) -> bool {
        true
    }
    fn stage(&self, receipt: StagingReceipt, value: &str) -> Result<()> {
        self.store.stage(receipt, value)?;
        if self.boundary == "staged" {
            std::process::exit(71);
        }
        Ok(())
    }
    fn lookup_staged(&self, request: &SecretRequest) -> Result<Option<StagingReceipt>> {
        self.store.lookup_staged(request)
    }
    fn activate(&self, request: &SecretRequest) -> Result<Activation> {
        if self.boundary == "selected" {
            std::process::exit(71);
        }
        let decision = self.store.activate(request)?;
        if self.boundary == "activated" {
            std::process::exit(71);
        }
        Ok(decision)
    }
    fn discard(&self, request: &SecretRequest) -> Result<()> {
        self.store.discard(request)
    }
}
fn build(root: &Path) -> modular_agent::AgentBuilder {
    Agent::builder().project(root).data_dir(root.join("data")).durability(Durability::Kept)
        .provider(scripted_provider(json!([
            {"toolCalls":[{"name":"ask_user","input":{"kind":"secret","question":"Token?","credential":"service"}}]},
            {"text":"Done"}
        ])))
}

#[tokio::test]
async fn secret_submission_survives_process_loss() -> Result<()> {
    const VALUE: &str = "offline-dummy-secret-value";
    if let Some(root) = std::env::var_os("SDK_SECRET_CRASH_ROOT") {
        let root = std::path::PathBuf::from(root);
        let agent = build(&root)
            .credentials(CrashStore {
                store: file_credentials(root.join("credentials.json")),
                boundary: std::env::var("SDK_SECRET_CRASH_BOUNDARY").unwrap(),
            })
            .build()
            .await?;
        let session = agent.session().await?;
        std::fs::write(root.join("session"), session.id())?;
        session.send("Ask for a token", Timing::Now).await?;
        let question = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(q) = session.questions()?.pop() {
                    return Ok::<_, modular_agent::Error>(q);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("question opened")?;
        std::fs::write(root.join("request"), &question.id)?;
        session
            .answer(&question.id, Answer::Secret(VALUE.into()))
            .await?;
        panic!("child missed crash boundary");
    }
    for boundary in ["staged", "selected", "activated"] {
        let root = tempfile::tempdir()?;
        let store = file_credentials(root.path().join("credentials.json"));
        store.write("service", "previous")?;
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(["--exact", "secret_submission_survives_process_loss"])
            .env("SDK_SECRET_CRASH_ROOT", root.path())
            .env("SDK_SECRET_CRASH_BOUNDARY", boundary)
            .status()?;
        assert_eq!(status.code(), Some(71), "{boundary}");
        if boundary != "activated" {
            assert_eq!(store.read("service")?, "previous");
        }
        let id = std::fs::read_to_string(root.path().join("session"))?;
        let request = std::fs::read_to_string(root.path().join("request"))?;
        let agent = build(root.path())
            .credentials(file_credentials(root.path().join("credentials.json")))
            .build()
            .await?;
        let session = agent.open_session(&id).await?;
        let entries = session.history()?;
        assert!(!format!("{entries:?}").contains(VALUE));
        let answer = entries
            .iter()
            .find(|e| e["kind"] == "inputAnswer" && e["requestId"] == request)
            .expect("terminal answer");
        if boundary == "staged" {
            assert_eq!(store.read("service")?, "previous");
            assert_eq!(answer["data"]["declined"], true);
            assert!(
                store
                    .lookup_staged(&SecretRequest {
                        session: id,
                        request
                    })?
                    .is_none()
            );
        } else {
            assert_eq!(store.read("service")?, VALUE);
            assert_eq!(answer["data"]["stored"], "service");
            assert!(entries.iter().any(|e| e["kind"] == "secretAnswerAccepted"));
        }
        assert!(session.questions()?.is_empty());
        agent.close().await?;
    }
    Ok(())
}

#[test]
fn slot_generations_supersede_stages_and_activation_is_idempotent() -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let store = file_credentials(tmp.path().join("credentials.json"));
    let receipt = |id: &str| StagingReceipt {
        request: SecretRequest {
            session: "one".into(),
            request: id.into(),
        },
        name: "slot".into(),
        actor: "user".into(),
        answer_session: "one".into(),
    };
    let a = receipt("a");
    let b = receipt("b");
    store.stage(a.clone(), "first")?;
    store.stage(b.clone(), "second")?;
    assert!(store.read("slot").is_err());
    assert_eq!(store.activate(&a.request)?, Activation::Activated);
    assert_eq!(store.activate(&b.request)?, Activation::Superseded);
    store.write("slot", "third")?;
    assert_eq!(store.activate(&a.request)?, Activation::Activated);
    assert_eq!(store.read("slot")?, "third");
    let c = receipt("c");
    store.discard(&c.request)?;
    assert!(store.stage(c, "fourth").is_err());
    Ok(())
}
