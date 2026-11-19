//! Runs one prompt step of a scenario in its own process, for crash steps.
//! Arguments: SCENARIO_FILE RUN_DIR STEP_INDEX PLACEMENT... Prints `SESSION <id>` first.
use sdk_scenarios::{Placement, Run, agent, load};
use std::io::Write;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let scenario = load(args[1].as_ref());
    let run = Run {
        dir: args[2].clone().into(),
        placement: Placement::from_args(&args[4..]),
    };
    let step = &scenario["steps"][args[3].parse::<usize>().unwrap()];
    let agent = agent(&scenario, &run).await.expect("agent");
    let session = agent.session().await.expect("session");
    println!("SESSION {}", session.id());
    std::io::stdout().flush().unwrap();
    let _ = session.prompt(step["prompt"].as_str().unwrap()).await;
}
