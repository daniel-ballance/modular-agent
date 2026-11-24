//! Writer loss is a process boundary. No tool effect is inferred from a request.
use modular_agent::{
    Agent, Answer, Approval, Durability, Plugin, Result, Tool, testing::scripted_provider,
};
use serde_json::{Value, json};
use std::{fs, io::Write, path::Path, process::Command};

async fn agent(dir: &Path, cut: &str, change: &str, durable: bool) -> Result<Agent> {
    let counter = dir.join("count");
    let exit = cut == "effect";
    let tool = Tool::new(
        "bump",
        if change == "definition" {
            "Replacement"
        } else {
            "Increment once"
        },
    )
    .safe_to_repeat()
    .run(move |_: Value, _| {
        let counter = counter.clone();
        async move {
            writeln!(
                fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open(counter)?,
                "bump"
            )?;
            if exit {
                std::process::exit(73)
            }
            Ok("done")
        }
    });
    let plugin = Plugin::new(if change == "source" {
        "replacement"
    } else {
        "original"
    })
    .tool(tool);
    let mut b = Agent::builder()
        .project(dir)
        .data_dir(dir.join("data"))
        .durability(if durable {
            Durability::Durable
        } else {
            Durability::Kept
        })
        .plugin(plugin)
        .provider(scripted_provider(if cut.is_empty() {
            json!([{"text":"Finished"}])
        } else {
            json!([{"toolCalls":[{"name":"bump","input":{}}]},{"text":"Finished"}])
        }));
    if change != "unsupported" {
        b = b
            .approval(Approval::All)
            .max_approval_wait_ms(if change == "shorter" { 10 } else { 60_000 });
    }
    b.build().await
}

#[tokio::test]
async fn recover_wait_decision_and_first_effect_across_processes() -> Result<()> {
    if let Some(dir) = std::env::var_os("RUST_WAIT_PROBE") {
        let dir = Path::new(&dir);
        let cut = std::env::var("RUST_WAIT_CUT").unwrap();
        let agent = agent(
            dir,
            &cut,
            "",
            std::env::var("RUST_WAIT_DURABLE").unwrap() == "yes",
        )
        .await?;
        let session = agent.session().await?;
        session.set_setting("approvalWait", json!("untilDeadline"))?;
        fs::write(dir.join("session"), session.id())?;
        session.prompt("Bump").await?;
        session.wait_idle().await?;
        let q = session.questions_present().await?.remove(0);
        fs::write(dir.join("view"), serde_json::to_vec(&q)?)?;
        if cut == "wait" {
            std::process::exit(73)
        }
        session.answer(&q.id, Answer::Allow).await?;
        if cut == "allow" {
            std::process::exit(73)
        }
        session.wait_idle().await?;
        panic!("missed effect");
    }
    for durable in [false, true] {
        for (cut, change, status) in [
            ("wait", "", "completed"),
            ("allow", "", "completed"),
            ("effect", "", "outcomeUnknown"),
            ("allow", "source", "refused"),
            ("allow", "definition", "refused"),
            ("wait", "unsupported", "notStarted"),
            ("wait", "shorter", "refused"),
        ] {
            let dir = tempfile::tempdir()?;
            let child = Command::new(std::env::current_exe()?)
                .args([
                    "--exact",
                    "recover_wait_decision_and_first_effect_across_processes",
                ])
                .env("RUST_WAIT_PROBE", dir.path())
                .env("RUST_WAIT_CUT", cut)
                .env("RUST_WAIT_DURABLE", if durable { "yes" } else { "no" })
                .status()?;
            assert_eq!(child.code(), Some(73), "{cut}/{change}");
            let id = fs::read_to_string(dir.path().join("session"))?;
            let view: Value = serde_json::from_slice(&fs::read(dir.path().join("view"))?)?;
            let agent = agent(dir.path(), "", change, durable).await?;
            let session = agent.open_session(&id).await?;
            if cut == "wait" && change.is_empty() {
                let qid = view["id"].as_str().unwrap();
                assert!(session.answer(qid, Answer::Allow).await.is_err());
                let fresh = session.questions_present().await?.remove(0);
                assert_eq!(json!(fresh), view);
                session.answer(qid, Answer::Allow).await?;
            }
            session.wait_idle().await?;
            let rows = session.history().await?;
            let results: Vec<_> = rows.iter().filter(|e| e["kind"] == "toolResult").collect();
            assert_eq!(
                results.len(),
                1,
                "durable={durable} cut={cut} change={change}"
            );
            assert_eq!(
                results[0]["data"]["status"], status,
                "durable={durable} cut={cut} change={change}"
            );
            assert_eq!(
                rows.iter().filter(|e| e["kind"] == "inputRequest").count(),
                1
            );
            assert_eq!(
                rows.iter().filter(|e| e["kind"] == "inputAnswer").count(),
                1
            );
            assert_eq!(
                fs::read_to_string(dir.path().join("count")).unwrap_or_default(),
                if status == "refused" || status == "notStarted" {
                    ""
                } else {
                    "bump\n"
                }
            );
            agent.close().await?;
        }
    }
    Ok(())
}
