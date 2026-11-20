//! Every scenario in conformance/sdk/scenarios, in process and served by every SDK's
//! fixture program listed in conformance/sdk/fixtures.
//!
//! A fixture program that has not been built is skipped and reported. Set
//! MODULAR_AGENT_SDK_REQUIRE to a comma-separated list of SDKs, or `all`, to fail instead.
use sdk_scenarios::Placement;

async fn run_all(placement: Placement) -> Vec<String> {
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
    failures
}

#[tokio::test(flavor = "multi_thread")]
async fn in_process() {
    let failures = run_all(Placement::InProcess).await;
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_on_a_committed_record() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("crash-on-record.json");
    let mut scenario = sdk_scenarios::load(
        &sdk_scenarios::repo().join("conformance/sdk/scenarios/kept-crash.json"),
    );
    scenario["steps"][0]["crashWhen"] = serde_json::json!({"record":"toolStarted"});
    // The crash may land before or after the effect, but it must be after the tool start.
    scenario["steps"][1]["expect"]
        .as_object_mut()
        .unwrap()
        .remove("count");
    std::fs::write(&path, scenario.to_string()).unwrap();
    let failures = sdk_scenarios::run(
        &path,
        &Placement::InProcess,
        env!("CARGO_BIN_EXE_scenario-agent").as_ref(),
    )
    .await;
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn served_by_every_sdk() {
    served(false, false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn service_rust() {
    served(true, true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn services_from_other_sdks() {
    served(true, false).await;
}

async fn served(service: bool, rust_only: bool) {
    let require = std::env::var("MODULAR_AGENT_SDK_REQUIRE").unwrap_or_default();
    let required = |sdk: &str| require == "all" || require.split(',').any(|s| s.trim() == sdk);
    let mut failures = vec![];
    for (sdk, placement) in sdk_scenarios::fixture_programs() {
        if service && (sdk == "rust") != rust_only {
            continue;
        }
        let kind = if service { "service" } else { "process" };
        // This SDK's own program is always the one cargo just built.
        let placement = if sdk == "rust" {
            Ok(Placement::Process {
                sdk: sdk.clone(),
                command: vec![env!("CARGO_BIN_EXE_modular-agent-fixtures").into()],
            })
        } else {
            placement
        };
        match placement {
            Ok(Placement::Process { sdk, command }) if service => {
                failures.extend(run_all(Placement::Service { sdk, command }).await)
            }
            Ok(p) => failures.extend(run_all(p).await),
            Err(why) if required(&sdk) => failures.push(format!("{kind}:{sdk}: {why}")),
            Err(why) => eprintln!("{kind}:{sdk}: skipped, {why}"),
        }
    }
    assert!(failures.is_empty(), "\n{}\n", failures.join("\n"));
}
