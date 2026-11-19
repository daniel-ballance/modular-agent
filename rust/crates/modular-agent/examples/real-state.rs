//! Explicit live demonstration, never an automated test. Only the credential
//! plugin reads the key. Evidence never records the generated private code.
use agent_api::*;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct Audit(Mutex<Vec<Value>>);
impl EventSink for Audit {
    fn send(&self, event: Event) {
        if event.kind == "provider.openai.request" {
            self.0.lock().unwrap().push(event.content);
        }
    }
}
struct NoTools;
impl Plugin for NoTools {
    fn name(&self) -> &str {
        "demo.no-tools"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "runtime.before.step",
            Order::Last,
            handler(|_, _, mut value| {
                Box::pin(async move {
                    value["request"]["tools"] = json!([]);
                    Ok(answer(value))
                })
            }),
        );
        Ok(())
    }
}
async fn ask(h: &Arc<agent_harness::Harness>, session: &str, text: &str) -> Result<TurnResult> {
    h.submit(session, "user", text, Timing::Now, None).await?;
    let result = h
        .run_next(session)
        .await?
        .ok_or_else(|| anyhow!("missing turn"))?;
    ensure!(
        result.outcome == Outcome::Completed,
        "demonstration turn did not complete: {:?}",
        result.error
    );
    Ok(result)
}
fn inventory(root: &std::path::Path, session: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(
        root.join("openai").join(format!("{session}.json")),
    )?)?)
}
#[tokio::main]
async fn main() -> Result<()> {
    let root = tempfile::TempDir::new()?;
    let project = root.path().join("project");
    std::fs::create_dir(&project)?;
    let home = PathBuf::from(std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME missing"))?);
    let audit = Arc::new(Audit::default());
    let h = modular_agent::compose(
        modular_agent::Options {
            history: root.path().join("sessions"),
            global_config: root.path().join("no-global-settings"),
            key_file: home.join(".config/modular-agent-experiment/openai.key"),
            secrets: vec![],
        },
        modular_agent::real_provider(root.path().join("openai"), provider_openai::Mode::Stateful),
        Arc::new(interface_terminal::TerminalPlugin {
            sink: audit.clone(),
        }),
        Arc::new(runtime_durable::DurablePlugin),
    )
    .await?;
    h.load(Arc::new(NoTools)).await?;
    let session = h.create(&project,json!({"model":"gpt-6-luna","thinking":"low","output_limit":512,"step_limit":2,"approval":"off"})).await?;
    let scope = Scope::session(&session);
    let mut evidence = json!({"model":"gpt-6-luna","provider_mode":"stateful","runtime":"durable","unix_time":now()/1000,"private_code_recorded_in_evidence":false});
    let proof: Result<()> = async {
        ensure!(h.declaration()?["provider_state"] == true, "missing state declaration");
        let code = format!("orchid-{}",id());
        let first = ask(&h,&session,&format!("Remember the private one-time code {code} for later in this conversation. Reply exactly ACK. Do not call tools.")).await?;
        ensure!(first.text.trim() == "ACK", "first response was not the requested acknowledgement");
        let question = "What is the private one-time code? Reply with exactly the code if it is in the conversation, otherwise reply exactly UNKNOWN. Do not call tools.";
        let second = ask(&h,&session,question).await?;
        ensure!(second.text.trim() == code, "stateful continuation did not recall the generated code");
        let before = inventory(root.path(),&session)?;
        ensure!(before["responses"].as_array().is_some_and(|v| v.len() == 2), "expected two stored response IDs before erasure");
        let data = h.snapshot(&session)?;
        let input = data.entries.iter().find(|e| e.kind == "input").ok_or_else(||anyhow!("missing first input"))?.id.clone();
        let erased = h.erase(&scope,vec![input]).await?;
        let after = inventory(root.path(),&session)?;
        ensure!(after["responses"].as_array().is_some_and(Vec::is_empty), "remote deletion was not completed");
        ensure!(!serde_json::to_string(&h.snapshot(&session)?)?.contains(&code), "erased code remained in local history");
        let third = ask(&h,&session,question).await?;
        ensure!(third.text.trim() == "UNKNOWN", "model still supplied a code after erasure");
        let requests = audit.0.lock().unwrap().clone();
        ensure!(requests.len() == 3, "expected exactly three short model requests");
        ensure!(requests[0]["continued"] == false && requests[1]["continued"] == true && requests[2]["continued"] == false, "unexpected request lineage");
        ensure!(requests[1]["input_items"] == 1, "continuation resent older items");
        let mut usage = first.usage; usage.add(&second.usage); usage.add(&third.usage);
        evidence["first_answer"] = json!("ACK");
        evidence["continued_recall_matched_generated_code"] = json!(true);
        evidence["after_erasure_answer"] = json!(third.text.trim());
        evidence["requests"] = json!(requests);
        evidence["usage"] = json!(usage);
        evidence["erased_entries"] = json!(erased.erased.len());
        evidence["known_remote_responses_deleted_at_erasure"] = json!(2);
        evidence["out_of_reach"] = json!(erased.out_of_reach);
        evidence["local_history_contains_erased_code"] = json!(false);
        Ok(())
    }.await;
    // Delete the final response too. Preserve recovery metadata if cleanup fails.
    let cleanup = h.erase(&scope, vec![]).await;
    let closed = h.close(&session).await;
    evidence["remote_cleanup_completed"] = json!(cleanup.is_ok());
    evidence["status"] = json!(if proof.is_ok() && cleanup.is_ok() && closed.is_ok() {
        "passed"
    } else {
        "failed"
    });
    if let Err(error) = &proof {
        evidence["error"] = json!(error.to_string());
    }
    if let Err(error) = &cleanup {
        evidence["cleanup_error"] = json!(error.to_string());
        evidence["recovery_directory"] = json!(root.keep());
    }
    std::fs::create_dir_all("evidence")?;
    std::fs::write(
        "evidence/m5-real-run.json",
        format!("{}\n", serde_json::to_string_pretty(&evidence)?),
    )?;
    proof?;
    cleanup?;
    closed?;
    println!(
        "Stateful recall and post-erasure UNKNOWN verified. Evidence: evidence/m5-real-run.json"
    );
    Ok(())
}
