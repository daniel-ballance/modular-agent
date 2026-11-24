//! Runs one prompt step of a scenario in its own process, for crash steps.
//! Arguments: SCENARIO_FILE RUN_DIR STEP_INDEX PLACEMENT... Prints `SESSION <id>` first.
use sdk_scenarios::{Placement, Run, crash_agent, load, run_telemetry, telemetry};
use std::io::Write;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|v| v == "--waiting") {
        sdk_scenarios::waiting::worker(&args[2..]).await.unwrap();
        return;
    }
    let request = telemetry::Request::from_env();
    let export = telemetry::install(request.as_ref().is_some_and(|r| r.sdk));
    if args.len() == 1 {
        let request = request.expect("telemetry adapter request");
        let binary = std::env::current_exe().expect("scenario-agent path");
        let failures = run_telemetry(&request, &binary).await;
        telemetry::flush(export).await;
        assert!(failures.is_empty(), "{}", failures.join("\n"));
        return;
    }
    let scenario = load(args[1].as_ref());
    let run = Run {
        dir: args[2].clone().into(),
        placement: Placement::from_args(&args[4..]),
    };
    let step = &scenario["steps"][args[3].parse::<usize>().unwrap()];
    let (agent, queue) = crash_agent(&scenario, &run, request.as_ref())
        .await
        .expect("agent");
    let session = agent.session().await.expect("session");
    println!("SESSION {}", session.id());
    std::io::stdout().flush().unwrap();
    let _ = session.prompt(step["prompt"].as_str().unwrap()).await;
    if let Some(queue) = queue {
        queue.assert_done().expect("scripted answers");
    }
    agent
        .close()
        .await
        .expect("close crash child on normal exit");
    telemetry::flush(export).await;
}
