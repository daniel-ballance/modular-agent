//! Every scenario in conformance/sdk/scenarios, in each placement this build can run.
use sdk_scenarios::Placement;

async fn run_all(placement: Placement) {
    let mut failures = vec![];
    for path in sdk_scenarios::scenarios() {
        let scenario = sdk_scenarios::load(&path);
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        if !sdk_scenarios::applies(&scenario, &placement) {
            eprintln!("{name} ({}): not applicable", placement.name());
            continue;
        }
        let found = sdk_scenarios::run(
            &path,
            &placement,
            env!("CARGO_BIN_EXE_scenario-agent").as_ref(),
        )
        .await;
        eprintln!(
            "{name} ({}): {}",
            placement.name(),
            if found.is_empty() {
                "pass".into()
            } else {
                format!("{} failed", found.len())
            }
        );
        failures.extend(found);
    }
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn in_process() {
    run_all(Placement::InProcess).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn served_by_rust() {
    run_all(Placement::Process {
        sdk: "rust".into(),
        command: vec![env!("CARGO_BIN_EXE_modular-agent-fixtures").into()],
    })
    .await;
}
