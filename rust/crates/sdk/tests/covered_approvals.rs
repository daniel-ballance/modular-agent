use modular_agent::{Answer, Approval, Result, Tool, ToolContext, ToolStatus, testing::test_agent};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

use modular_agent::{Durability, Gate, Plugin};
use std::sync::atomic::{AtomicUsize, Ordering};

fn calls(name: &str, child: &'static str) -> Tool {
    Tool::new(name, "Call a nested tool").run(move |_: Value, cx: ToolContext| async move {
        Ok(cx.tools().call(child, json!({})).await?.text().to_owned())
    })
}

#[tokio::test]
async fn an_allow_covers_two_depths_and_records_the_same_request() -> Result<()> {
    let seen = Arc::new(Mutex::new(vec![]));
    let shown = seen.clone();
    let agent = test_agent()
        .approval(Approval::All)
        .approval_covers_nested(true)
        .on_question(move |q| {
            shown.lock().unwrap().push(q);
            std::future::ready(Answer::Allow)
        })
        .tool(calls("outer", "middle"))
        .tool(calls("middle", "inner"))
        .tool(Tool::new("inner", "Finish").run(|_: Value, _| async { Ok("finished") }))
        .script(json!([{"toolCalls":[{"name":"outer","input":{}}]},{"text":"done"}]))
        .build()
        .await?;
    assert_eq!(agent.declaration()?["approvalCoversNested"], true);
    let session = agent.session().await?;
    let turn = session.prompt("run").await?;
    assert_eq!(turn.tool_results()[0].status, ToolStatus::Completed);
    assert_eq!(turn.tool_results()[0].text(), "finished");
    let q = {
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        seen[0].clone()
    };
    assert!(q.covers_nested);
    let history = session.history().await?;
    let starts: Vec<_> = history
        .iter()
        .filter(|e| e["kind"] == "toolStarted")
        .collect();
    assert_eq!(starts.len(), 3);
    assert!(starts[0]["data"].get("approvalCoveredBy").is_none());
    let cover = json!({"toolCallId":starts[0]["toolCallId"],"requestId":q.id});
    for e in &starts[1..] {
        assert_eq!(e["data"]["approvalCoveredBy"], cover);
    }
    assert!(
        history
            .iter()
            .any(|e| e["kind"] == "inputRequest" && e["data"]["request"]["coversNested"] == true)
    );
    agent.close().await
}

#[tokio::test]
async fn only_an_explicit_parent_allow_answers_the_nested_gate() -> Result<()> {
    for (case, policy, cover, readonly, expected_questions, starts) in [
        ("denied", Approval::All, true, false, vec!["outer"], 0),
        ("never", Approval::Never, true, false, vec![], 0),
        (
            "no cover",
            Approval::Ask,
            false,
            false,
            vec!["outer", "inner"],
            1,
        ),
        ("no question", Approval::Ask, true, true, vec!["inner"], 1),
        ("another gate", Approval::All, true, false, vec!["outer"], 1),
    ] {
        let asked = Arc::new(Mutex::new(vec![]));
        let seen = asked.clone();
        let outer = Tool::new("outer", "Run inner");
        let outer = if readonly { outer.read_only() } else { outer };
        let agent = test_agent()
            .approval(policy)
            .approval_covers_nested(cover)
            .on_question(move |q| {
                let name = q.call.unwrap()["name"].as_str().unwrap().to_string();
                assert_eq!(q.covers_nested, cover && name == "outer", "{case}");
                let allow = case != "denied" && name == "outer";
                seen.lock().unwrap().push(name);
                std::future::ready(allow.then_some(Answer::Allow))
            })
            .tool(outer.run(|_: Value, cx| async move {
                Ok(cx.tools().call("inner", json!({})).await?.text().to_owned())
            }))
            .tool(Tool::new("inner", "Must not run").run(|_: Value, _| async {
                panic!("unexpected inner dispatch");
                #[allow(unreachable_code)]
                Ok("")
            }))
            .plugin(
                Plugin::new("deny-inner").on_tool_before(move |hook| async move {
                    Ok(if case == "another gate" && hook.name == "inner" {
                        Gate::Refuse("blocked".into())
                    } else {
                        Gate::Allow
                    })
                }),
            )
            .script(json!([{"toolCalls":[{"name":"outer","input":{}}]},{"text":"done"}]))
            .build()
            .await?;
        assert_eq!(
            agent.declaration()?.get("approvalCoversNested").is_some(),
            cover
        );
        let session = agent.session().await?;
        session.prompt("run").await?;
        assert_eq!(*asked.lock().unwrap(), expected_questions, "{case}");
        let history = session.history().await?;
        assert_eq!(
            history
                .iter()
                .filter(|e| e["kind"] == "toolStarted")
                .count(),
            starts,
            "{case}"
        );
        assert!(
            history
                .iter()
                .any(|e| e["kind"] == "toolResult" && e["data"]["status"] == "refused"),
            "{case}"
        );
        agent.close().await?;
    }
    let agent = test_agent().approval_covers_nested(true).build().await?;
    assert!(agent.declaration()?.get("approvalCoversNested").is_none());
    agent.close().await
}

#[tokio::test]
async fn a_waiting_allow_covers_only_what_the_original_view_offered() -> Result<()> {
    for marked in [false, true] {
        let dir = tempfile::tempdir()?;
        let count = Arc::new(AtomicUsize::new(0));
        let build = |cover| {
            let counter = count.clone();
            test_agent()
                .data_dir(dir.path())
                .project(dir.path())
                .durability(Durability::Kept)
                .approval(Approval::All)
                .approval_covers_nested(cover)
                .max_approval_wait_ms(60_000)
                .setting("approvalWait", json!("untilDeadline"))
                .tool(calls("outer", "inner"))
                .tool(Tool::new("inner", "Count").run(move |_: Value, _| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async { Ok("done") }
                }))
                .script(json!([{"toolCalls":[{"name":"outer","input":{}}]},{"text":"done"}]))
        };
        let agent = build(marked).build().await?;
        let session = agent.session().await?;
        assert_eq!(session.prompt("run").await?.open_tool_calls.len(), 1);
        session.wait_idle().await?;
        let id = session.id().to_string();
        let qid = session.questions()?[0].id.clone();
        session.close().await?;
        agent.close().await?;

        let agent = build(true).build().await?;
        let session = agent.open_session(&id).await?;
        let q = session.questions_present().await?.remove(0);
        assert_eq!(q.covers_nested, marked);
        assert_eq!(q.id, qid);
        session.answer(&qid, Answer::Allow).await?;
        session.wait_idle().await?;
        assert_eq!(count.load(Ordering::SeqCst), usize::from(marked));
        let history = session.history().await?;
        let parent = history
            .iter()
            .find(|e| e["kind"] == "toolStarted" && e["data"]["call"]["name"] == "outer")
            .unwrap();
        let child = history
            .iter()
            .find(|e| e["kind"] == "toolStarted" && e["data"]["call"]["name"] == "inner");
        if marked {
            assert_eq!(
                child.unwrap()["data"]["approvalCoveredBy"],
                json!({"toolCallId":parent["toolCallId"],"requestId":qid})
            );
        } else {
            assert!(child.is_none());
        }
        agent.close().await?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_recovered_parent_needs_a_new_allow() -> Result<()> {
    use modular_agent::{Agent, testing::scripted_provider};
    use std::{fs, path::Path, process::Command};
    let child = std::env::var_os("RUST_COVER_PROBE");
    let temp = tempfile::tempdir()?;
    let dir = child.as_deref().map(Path::new).unwrap_or(temp.path());
    let first = child.is_some();
    let agent = Agent::builder()
        .project(dir)
        .data_dir(dir.join("state"))
        .durability(Durability::Durable)
        .approval(Approval::All)
        .approval_covers_nested(true)
        .on_question(|_| std::future::ready(Answer::Allow))
        .tool(Tool::new("outer", "Run inner").safe_to_repeat().run(
            move |_: Value, cx| async move {
                let result = cx.tools().call("inner", json!({})).await?;
                if first {
                    std::process::exit(73);
                }
                Ok(result.text().to_owned())
            },
        ))
        .tool(Tool::new("inner", "A nested call").run(|_: Value, _| async { Ok("done") }))
        .provider(scripted_provider(if first {
            json!([{"toolCalls":[{"name":"outer","input":{}}]}])
        } else {
            json!([{"text":"done"}])
        }))
        .build()
        .await?;
    if first {
        let s = agent.session().await?;
        fs::write(dir.join("id"), s.id())?;
        s.prompt("run").await?;
        panic!("missed the first dispatch");
    }
    let status = Command::new(std::env::current_exe()?)
        .args(["--exact", "a_recovered_parent_needs_a_new_allow"])
        .env("RUST_COVER_PROBE", dir)
        .status()?;
    assert_eq!(status.code(), Some(73));
    let session = agent
        .open_session(&fs::read_to_string(dir.join("id"))?)
        .await?;
    let history = session.history().await?;
    let requests: Vec<_> = history
        .iter()
        .filter(|e| e["kind"] == "inputRequest")
        .map(|e| e["requestId"].clone())
        .collect();
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[0], requests[1]);
    let covers: Vec<_> = history
        .iter()
        .filter_map(|e| e["data"]["approvalCoveredBy"].get("requestId").cloned())
        .collect();
    assert_eq!(covers, requests);
    agent.close().await
}
