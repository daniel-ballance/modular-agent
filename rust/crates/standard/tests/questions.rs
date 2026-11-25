//! The line terminal shows a question only once it can be answered.
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[test]
fn an_answer_sent_as_soon_as_the_question_is_shown_is_accepted() {
    let code = "tools.write(path='answer', content=str(tools.ask_user(question='Colour?', kind='choice', options=['teal', 'red'])))";
    for _ in 0..5 {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path();
        let project = dir.join("project");
        fs::create_dir_all(&project).unwrap();
        let script = dir.join("script");
        fs::write(
            &script,
            json!([{"toolCalls":[{"name":"codemode","input":{"code":code}}]}, {"text":"done"}])
                .to_string(),
        )
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_ma"))
            .env("MODULAR_AGENT_SCRIPT", script)
            .env("MODULAR_AGENT_DATA_DIR", dir)
            .env_remove("MODULAR_AGENT_CONFORMANCE")
            .env_remove("MODULAR_AGENT_HISTORY_URL")
            .arg("--project")
            .arg(&project)
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take();
        writeln!(stdin.as_mut().unwrap(), "Run").unwrap();
        let mut shown = Vec::new();
        for line in BufReader::new(child.stderr.take().unwrap()).lines() {
            let line = line.unwrap();
            if let Some(id) = line
                .strip_prefix("Question ")
                .and_then(|rest| rest.split_once(':'))
                .map(|(id, _)| id.to_owned())
            {
                writeln!(stdin.take().unwrap(), "/answer {id} teal").unwrap();
            }
            shown.push(line);
        }
        assert!(child.wait().unwrap().success());
        let shown = shown.join("\n");
        assert!(shown.contains("Colour? [\"teal\",\"red\"]"), "{shown}");
        assert!(!shown.contains("no question named"), "{shown}");
        assert!(
            fs::read_to_string(project.join("answer")).is_ok_and(|answer| answer.contains("teal")),
            "{shown}"
        );
    }
}
