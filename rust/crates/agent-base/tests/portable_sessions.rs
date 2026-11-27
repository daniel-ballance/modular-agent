use agent_api::*;
use tempfile::TempDir;

#[tokio::test]
async fn a_session_with_only_standard_history_loads_recovers_and_takes_new_input() {
    reopen(false).await;
}

#[tokio::test]
async fn a_served_durable_runtime_recovers_started_calls_without_tools_authority() {
    reopen(true).await;
}

#[test]
fn non_string_approval_refuses_portable_history() {
    let deep = (0..48).fold(json!("off"), |nested, _| json!({ "nested": nested }));
    for value in [
        Value::Null,
        json!(1),
        json!(["off"]),
        json!({"approval": "off"}),
        json!(true),
        json!(vec!["off"; 2048]),
        deep,
    ] {
        for setting in [
            json!({"key": "approval", "value": value}),
            json!({"key": "settings", "value": {"approval": value}}),
        ] {
            let meta = json!({"id": "foreign", "project": "."});
            let entry = json!({"id": "setting", "kind": "setting", "sessionId": "foreign",
                "parentId": null, "time": 1, "writer": "foreign", "data": setting});
            let err = portable::session(&meta, &[entry]).expect_err("malformed history");
            assert!(err.to_string().contains("approval"), "{err}");
        }
    }
}

#[test]
fn off_branch_cleanup_unconfirmed_is_payload_free_and_survives_until_job_end() {
    let row = |id: &str, parent: Option<&str>, kind: &str, data: Value| {
        let mut entry = json!({"id":id,"parentId":parent,"sessionId":"portable","time":0,
            "kind":kind,"modelVisible":false,"writer":"test","actorId":"user"});
        if kind.starts_with("job") {
            entry["jobId"] = json!("job");
        }
        if !data.is_null() {
            entry["data"] = data;
        }
        entry
    };
    let mut entries = vec![
        row("mark", None, "test.mark", Value::Null),
        row("start", Some("mark"), "jobStarted", json!({"kind":"test"})),
        row(
            "uncertain",
            Some("start"),
            "jobCleanupUnconfirmed",
            Value::Null,
        ),
        row("move", Some("uncertain"), "position", json!({"to":"mark"})),
    ];
    let meta = json!({"id":"portable","project":"/tmp"});
    let data = portable::session(&meta, &entries).unwrap();
    assert!(!data.branch().iter().any(|e| e.id == "uncertain"));
    let marker = data.entries.iter().find(|e| e.id == "uncertain").unwrap();
    assert_eq!(portable::entry(marker, &data).unwrap(), entries[2]);
    assert_eq!(jobs(&data).unwrap()[0].state, JobState::CleanupUnconfirmed);
    entries.push(row(
        "end",
        Some("mark"),
        "jobEnded",
        json!({"outcome":{"kind":"cancelled"},"report":false}),
    ));
    let data = portable::session(&meta, &entries).unwrap();
    assert_eq!(jobs(&data).unwrap()[0].state, JobState::Cancelled);
}

async fn reopen(served: bool) {
    let state = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let root = state.path().join("sessions");
    std::fs::create_dir(&root).unwrap();
    let row = |id: &str, parent: Option<&str>, kind: &str, extra: Value| {
        let mut entry = json!({"id":id,"parentId":parent,"sessionId":"foreign","time":0,"kind":kind,"modelVisible":matches!(kind,"input"|"response"|"summary"),"writer":"another-agent","actorId":"user"});
        merge(&mut entry, extra);
        entry
    };
    let entries = vec![
        row(
            "settings",
            None,
            "setting",
            json!({"data":{"key":"settings","value":{"model":{"provider":"fake","id":"fake"},"maxSteps":3}}}),
        ),
        row(
            "join",
            Some("settings"),
            "actorJoined",
            json!({"data":{"actor":{"id":"reader","kind":"user","rights":["watch"]}}}),
        ),
        row(
            "receipt",
            Some("join"),
            "inputAccepted",
            json!({"inputId":"receipt","data":{"when":"now","taken":"now","rights":["watch","input","tools"],"authorizers":[{"sessionId":"foreign","actorId":"user"}],"key":"keep-once","content":[{"type":"text","text":"Foreign user text"}]}}),
        ),
        row(
            "start",
            Some("receipt"),
            "turnStart",
            json!({"turnId":"interrupted","data":{"startedBy":{"kind":"actor","id":"user"},"model":{"provider":"fake","id":"fake"},"tools":[{"name":"read","description":"read a file","parameters":{"type":"object"},"hints":{"readOnly":true,"safeToRepeat":true}}],"settings":{"maxSteps":3},"system":"foreign prompt"}}),
        ),
        row(
            "input",
            Some("start"),
            "input",
            json!({"turnId":"interrupted","sources":["receipt"],"inputId":"receipt","data":{"key":"keep-once"},"message":{"role":"user","content":[{"type":"text","text":"Foreign user text","newField":true}]}}),
        ),
        row(
            "intent",
            Some("input"),
            "modelRequest",
            json!({"turnId":"interrupted","stepId":"step","data":{"model":{"provider":"fake","id":"fake"},"tools":["read"],"safeToRepeat":false}}),
        ),
        row(
            "response",
            Some("intent"),
            "response",
            json!({"turnId":"interrupted","stepId":"step","message":{"role":"assistant","stop":"toolUse","content":[{"type":"toolCall","id":"call","name":"bash","arguments":{"command":"touch must-not-run"}},{"type":"toolCall","id":"repeat","name":"read","arguments":{"path":"missing"}},{"type":"toolCall","id":"fresh","name":"bash","arguments":{"command":"touch must-not-run"}}]}}),
        ),
        row(
            "started-call",
            Some("response"),
            "toolStarted",
            json!({"turnId":"interrupted","stepId":"step","toolCallId":"call","data":{"safeToRepeat":false,"call":{"id":"call","name":"bash","input":{"command":"touch must-not-run"},"startedBy":"model"}}}),
        ),
        row(
            "started-repeatable",
            Some("started-call"),
            "toolStarted",
            json!({"turnId":"interrupted","stepId":"step","toolCallId":"repeat","data":{"safeToRepeat":true,"call":{"id":"repeat","name":"read","input":{"path":"missing"},"startedBy":"model"}}}),
        ),
        row(
            "restricted",
            Some("started-repeatable"),
            "actorJoined",
            json!({"data":{"actor":{"id":"user","kind":"user","rights":["watch","input","future.tools"]}}}),
        ),
        row(
            "left",
            Some("restricted"),
            "actorLeft",
            json!({"data":{"actorId":"reader"}}),
        ),
        // Moving to an earlier branch must not undo actor or key state.
        row(
            "move",
            Some("left"),
            "position",
            json!({"data":{"to":"started-repeatable"}}),
        ),
    ];
    history_fs::FileHistory::new(&root).unwrap();
    std::fs::write(root.join("foreign.json"),json!({"historyBinding":"modular-agent-data/1","id":"foreign","project":project.path(),"entries":entries,"plugins":[]}).to_string()).unwrap();
    let fake = std::sync::Arc::new(provider_fake::FakePlugin::new(vec![
        provider_fake::Script::response(ModelResponse::text("carried on")),
        provider_fake::Script::response(ModelResponse::text("next")),
    ]));
    let h = agent_base::compose(
        agent_base::Options {
            history: root,
            global_config: state.path().join("no-config"),
            key_file: state.path().join("no-key"),
            secrets: vec![],
        },
        fake.clone(),
        std::sync::Arc::new(interface_terminal::TerminalPlugin {
            sink: std::sync::Arc::new(interface_terminal::TerminalSink::new(
                interface_terminal::Mode::Json,
            )),
        }),
        std::sync::Arc::new(runtime_durable::DurablePlugin),
    )
    .await
    .unwrap();
    let remote = if served {
        Some(
            plugin_stdio::load(
                &h,
                plugin_stdio::Launch {
                    command: vec![
                        env!("CARGO_BIN_EXE_modular-agent").into(),
                        "--serve-plugin".into(),
                    ],
                    env: [(
                        "MODULAR_AGENT_PLUGIN_PARTS".into(),
                        "durable-runtime".into(),
                    )]
                    .into(),
                    config: json!({}),
                },
                project.path(),
                &state.path().join("runtime-plugin"),
                0,
            )
            .await
            .unwrap(),
        )
    } else {
        None
    };
    h.open("foreign").await.unwrap();
    let state = h.snapshot("foreign").unwrap();
    let actor_rights = h.authority("foreign", "user").unwrap();
    assert!(!actor_rights.has("tools"));
    assert!(!actor_rights.has("future.tools"));
    let actor = state.entries.iter().find(|e| e.id == "restricted").unwrap();
    let actor = portable::entry(actor, &state).unwrap();
    assert_eq!(
        actor["data"]["actor"]["rights"],
        json!(["watch", "input", "future.tools"])
    );
    let branch = state.branch();
    for (id, status, starts) in [
        ("call", "outcomeUnknown", 1),
        ("repeat", "outcomeUnknown", 1),
        ("fresh", if served { "notStarted" } else { "refused" }, 0),
    ] {
        let records: Vec<_> = branch
            .iter()
            .filter(|e| e.scope.call.as_deref() == Some(id))
            .collect();
        let results: Vec<_> = records
            .iter()
            .filter(|e| e.kind == "tool.result")
            .map(|e| portable::entry(e, &state).unwrap())
            .collect();
        assert_eq!(results.len(), 1, "{id}");
        assert_eq!(results[0]["data"]["status"], status, "{id}");
        assert_eq!(results[0]["toolCallId"], id);
        assert!(
            results[0]["sources"]
                .as_array()
                .unwrap()
                .iter()
                .all(|source| branch
                    .iter()
                    .any(|e| e.id == source.as_str().unwrap() && e.writer != "rust.derived"))
        );
        assert_eq!(
            records.iter().filter(|e| e.kind == "tool.started").count(),
            starts,
            "{id}"
        );
    }
    assert_eq!(state.settings["step_limit"], 3);
    assert_eq!(state.settings["approval"], "ask_always");
    assert!(!h.authority("foreign", "reader").unwrap().has("watch"));
    assert!(!project.path().join("must-not-run").exists());
    let duplicate = h
        .submit(
            "foreign",
            "user",
            "ignored",
            Timing::Now,
            Some("keep-once".into()),
        )
        .await
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.input, "receipt");
    h.submit("foreign", "user", "Go on", Timing::Now, None)
        .await
        .unwrap();
    assert_eq!(h.run_next("foreign").await.unwrap().unwrap().text, "next");
    h.close("foreign").await.unwrap();
    if let Some(remote) = remote {
        remote.shutdown().await.unwrap();
    }
    let requests = fake.probe.requests.lock().unwrap();
    assert_eq!(requests[0].system, "foreign prompt");
    assert!(
        requests[0]
            .messages
            .iter()
            .any(|msg| msg.text_content() == "Foreign user text")
    );
    assert!(
        requests[1]
            .messages
            .iter()
            .any(|msg| msg.text_content() == "carried on")
    );
}
