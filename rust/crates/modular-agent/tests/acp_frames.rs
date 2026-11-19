use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[test]
fn acp_accepts_crlf_and_refuses_a_request_beyond_the_wire_depth() {
    let state = tempfile::tempdir().unwrap();
    let mut agent = Command::new(env!("CARGO_BIN_EXE_modular-agent"))
        .arg("--acp")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("HOME", state.path())
        .env("MODULAR_AGENT_CONFORMANCE", "1")
        .current_dir(state.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = agent.stdin.take().unwrap();
    let mut stdout = BufReader::new(agent.stdout.take().unwrap());
    let request = |id: u64, depth: usize| {
        format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"unknown\",\"params\":{{\"x\":{}0{}}}}}\r\n",
            "[".repeat(depth),
            "]".repeat(depth)
        )
    };
    stdin.write_all(request(1, 63).as_bytes()).unwrap();
    stdin.write_all(request(2, 62).as_bytes()).unwrap();
    let mut rejected = String::new();
    let mut accepted = String::new();
    stdout.read_line(&mut rejected).unwrap();
    stdout.read_line(&mut accepted).unwrap();
    drop(stdin);
    assert!(agent.wait().unwrap().success());
    let rejection: serde_json::Value = serde_json::from_str(&rejected).unwrap();
    let acceptance: serde_json::Value = serde_json::from_str(&accepted).unwrap();
    assert_eq!(rejection["id"], 1);
    assert_eq!(rejection["error"]["code"], -32602);
    assert_eq!(rejection["error"]["data"]["code"], "invalid_request");
    assert_eq!(acceptance["id"], 2);
    // The second frame reached the application's initialization check.
    assert_ne!(acceptance["error"]["data"]["code"], "invalid_request");
}
