//! Every scenario in conformance/sdk/scenarios, in process.
#[tokio::test(flavor = "multi_thread")]
async fn every_shared_scenario_passes_in_process() {
    let mut failures = vec![];
    for path in sdk_scenarios::scenarios() {
        let found = sdk_scenarios::run(&path, env!("CARGO_BIN_EXE_scenario-agent").as_ref()).await;
        eprintln!(
            "{}: {}",
            path.file_stem().unwrap().to_string_lossy(),
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
