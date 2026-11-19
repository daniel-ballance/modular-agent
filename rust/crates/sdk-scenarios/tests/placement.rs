//! Placement rules from docs/sdk/placement.md, checked with the Rust fixture program.
//! One test per binary touches MODULAR_AGENT_PLUGINS, so nothing races on it.
use modular_agent::{Code, ProcessPlugin, testing::test_agent};
use serde_json::json;

const FIXTURES: &str = env!("CARGO_BIN_EXE_modular-agent-fixtures");

#[tokio::test]
async fn placement_rules() {
    // A program that cannot start fails the agent: it never runs without a configured part.
    let missing = test_agent()
        .process_plugin(ProcessPlugin::new(["/nonexistent/plugin-program"]))
        .build()
        .await;
    assert_eq!(
        missing.err().map(|e| e.code()),
        Some(Code::InvalidComposition)
    );

    // Listed programs cannot be used to bypass mandatory host discovery.
    let contradictory = test_agent()
        .plugin_host(false)
        .process_plugin(ProcessPlugin::new([FIXTURES, "tide"]))
        .build()
        .await;
    let error = contradictory
        .err()
        .expect("must refuse a non-host with a program");
    assert_eq!(error.code(), Code::InvalidComposition);
    assert!(error.message().contains("require a plugin host"));

    // So does one that exits before registering.
    let unknown = test_agent()
        .process_plugin(ProcessPlugin::new([FIXTURES, "no-such-fixture"]))
        .build()
        .await;
    assert_eq!(
        unknown.err().map(|e| e.code()),
        Some(Code::InvalidComposition)
    );

    // An embedded agent is not a plugin host: it ignores MODULAR_AGENT_PLUGINS.
    let broken = json!([{ "command": ["/nonexistent/plugin-program"] }]).to_string();
    // SAFETY: this is the only test in this binary.
    unsafe { std::env::set_var("MODULAR_AGENT_PLUGINS", &broken) };
    let embedded = test_agent().script(json!([{ "text": "ok" }])).build().await;
    assert!(
        embedded.is_ok(),
        "an embedded agent started a program from its environment"
    );

    // A plugin host does read it, and so fails here.
    let host = test_agent().plugin_host(true).build().await;
    assert_eq!(host.err().map(|e| e.code()), Some(Code::InvalidComposition));
    unsafe { std::env::remove_var("MODULAR_AGENT_PLUGINS") };

    // A served tool works as it does in process.
    let agent = test_agent()
        .process_plugin(ProcessPlugin::new([FIXTURES, "tide"]))
        .script(json!([
            { "toolCalls": [{ "name": "tide", "input": { "harbour": "Staithes" } }] },
            { "text": "Done." }
        ]))
        .build()
        .await
        .unwrap();
    let turn = agent
        .session()
        .await
        .unwrap()
        .prompt("Tide?")
        .await
        .unwrap();
    assert_eq!(
        turn.tool_results()[0].text(),
        "High tide at Staithes is 14:02."
    );
    agent.close().await.unwrap();
}
