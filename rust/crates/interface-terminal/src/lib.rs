//! Terminal Interface plugin. Uses only the shared plugin API.
use agent_api::*;
use std::{
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncBufReadExt, BufReader};
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Line,
    Print,
    Json,
}
pub struct TerminalPlugin {
    pub sink: Arc<dyn EventSink>,
}
impl Plugin for TerminalPlugin {
    fn name(&self) -> &str {
        "interface.terminal"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn EventSink>("interface.terminal", self.sink.clone())
    }
}
pub struct TerminalSink {
    pub mode: Mode,
    lock: Mutex<()>,
}
impl TerminalSink {
    pub fn new(mode: Mode) -> Self {
        Self {
            mode,
            lock: Mutex::new(()),
        }
    }
}
impl EventSink for TerminalSink {
    fn send(&self, event: Event) {
        let _guard = self.lock.lock().unwrap();
        if self.mode == Mode::Json {
            println!("{}", serde_json::to_string(&event).unwrap());
            return;
        }
        match event.kind.as_str() {
            "session.open" => eprintln!("Session: {}", event.scope.session),
            "tool.progress" => {
                eprint!("{}", event.content.as_str().unwrap_or(""));
                let _ = io::stderr().flush();
            }
            "model.delta" if self.mode == Mode::Line => {
                print!("{}", event.content.as_str().unwrap_or(""));
                let _ = io::stdout().flush();
            }
            "turn.result" => {
                if self.mode == Mode::Print {
                    println!("{}", event.content["text"].as_str().unwrap_or(""));
                } else {
                    println!();
                }
                if let Some(error) = event.content["error"].as_str() {
                    eprintln!("{error}");
                }
            }
            "request.opened" => eprintln!(
                "Question {}: {} {}\nUse /answer REQUEST_ID VALUE",
                event.content["id"].as_str().unwrap_or(""),
                event.content["text"].as_str().unwrap_or(""),
                event.content["options"]
            ),
            "job.ended" => eprintln!(
                "Job {}: {}",
                event.content["id"].as_str().unwrap_or(""),
                event.content["state"]
            ),
            "command.result" => println!("{}", event.content),
            "input.returned" => eprintln!(
                "Returned input: {}",
                event.content["text"].as_str().unwrap_or("")
            ),
            _ => (),
        }
    }
}
pub struct TerminalOptions {
    pub project: PathBuf,
    pub session: Option<String>,
    pub prompt: Option<String>,
    pub settings: Value,
    pub mode: Mode,
    pub list: bool,
    pub all_projects: bool,
    pub history: bool,
    pub declaration: bool,
}
async fn drain(api: Api, session: String) -> Result<()> {
    loop {
        let Some(result) = api.next_turn(&session).await? else {
            if jobs(&api.snapshot(&session)?)?
                .iter()
                .any(|j| j.state == JobState::Running)
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                continue;
            }
            break;
        };
        if result.outcome != Outcome::Completed && result.open_calls.is_empty() {
            bail!(
                "{}",
                result
                    .error
                    .unwrap_or_else(|| format!("{:?}", result.outcome))
            );
        }
    }
    Ok(())
}
async fn terminal_input(api: &Api, session: &str, line: &str, timing: Timing) -> Result<()> {
    // Answers, especially secrets, must never pass through ordinary input/command recording.
    if let Some(args) = line.strip_prefix("/answer ") {
        let (id, value) = args
            .split_once(' ')
            .ok_or_else(|| anyhow!("use /answer REQUEST_ID VALUE"))?;
        requests(api.as_ref())?
            .answer(api.clone(), session, "user", id, json!(value), false)
            .await?;
    } else if line == "/questions" {
        api.emit(Event::new(
            &Scope::session(session),
            "command.result",
            json!(requests(api.as_ref())?.visible(api.as_ref(), session, "user")?),
        ))
        .await?;
    } else if line == "/jobs" {
        api.emit(Event::new(
            &Scope::session(session),
            "command.result",
            json!({"jobs":jobs(&api.snapshot(session)?)?,"usage":session_usage(&api.snapshot(session)?)?}),
        ))
        .await?;
    } else if let Some(id) = line.strip_prefix("/cancel-job ") {
        job_service(api.as_ref())?
            .cancel(api.clone(), session, "user", id)
            .await?;
    } else if let Some(value) = line.strip_prefix("/tool ") {
        let v: Value = serde_json::from_str(value)?;
        let call = ToolCall::new(
            v["name"]
                .as_str()
                .ok_or_else(|| anyhow!("tool name required"))?,
            v["input"].clone(),
        );
        let runtime: Arc<dyn Runtime> = capability(api.as_ref(), "runtime")?;
        runtime
            .tool(api.clone(), Scope::session(session), call)
            .await?;
    } else {
        api.submit(session, "user", line, timing, None).await?;
    }
    Ok(())
}
async fn stop_jobs(api: &Api, session: &str) -> Result<()> {
    for job in jobs(&api.snapshot(session)?)?
        .iter()
        .filter(|j| j.state == JobState::Running)
    {
        job_service(api.as_ref())?
            .cancel(api.clone(), session, "user", &job.id)
            .await?;
    }
    Ok(())
}
async fn finish_eof(
    api: &Api,
    session: &str,
    mut task: tokio::task::JoinHandle<Result<()>>,
) -> Result<()> {
    let service = requests(api.as_ref())?;
    service.presence(session, "user", false);
    loop {
        tokio::select! {
            result = &mut task => { let _ = result?; return Ok(()); }
            _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {
                for q in service.visible(api.as_ref(), session, "user")?.iter().filter(|q| q.answerable) {
                    // EOF cannot answer a question, including one opened after EOF.
                    if api.is_running(&q.scope.session) { api.cancel(&q.scope.session).await?; }
                }
            }
        }
    }
}
pub async fn run(api: Api, options: TerminalOptions) -> Result<()> {
    let interactive =
        options.prompt.is_none() && !options.list && !options.history && !options.declaration;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let session = if let Some(id) = options.session {
        if interactive {
            requests(api.as_ref())?.presence(&id, "user", true);
            let opening = api.open(&id);
            tokio::pin!(opening);
            loop {
                tokio::select! {
                    result = &mut opening => { result?; break; }
                    line = lines.next_line() => {
                        if let Some(line) = line? { terminal_input(&api, &id, &line, Timing::After).await?; }
                        else {
                            // The lease may still be held by a crashed process. EOF
                            // before the session exists cannot cancel recovery.
                            if api.snapshot(&id).is_ok() { api.cancel(&id).await?; }
                            opening.await?;
                            break;
                        }
                    }
                }
            }
        } else {
            api.open(&id).await?;
        }
        id
    } else {
        api.create(&options.project, options.settings).await?
    };
    let scope = Scope::session(&session);
    requests(api.as_ref())?.presence(&session, "user", interactive);
    api.emit(Event::new(
        &scope,
        "session.open",
        json!({"session":session}),
    ))
    .await?;
    let result:Result<()>=async{
        if options.declaration{api.emit(Event::new(&scope,"command.result",api.declaration()?)).await?;return Ok(())}
        if options.history{api.emit(Event::new(&scope,"command.result",api.history_view(&session).await?)).await?;return Ok(())}
        if options.list{
            let args=if options.all_projects{"all"}else{""};
            let value=api.command(&scope,"sessions",args).await?;api.emit(Event::new(&scope,"command.result",value)).await?;return Ok(())
        }
        if let Some(prompt)=options.prompt{
            api.submit(&session,"user",&prompt,Timing::Now,None).await?;
            return drain(api.clone(),session.clone()).await
        }
        ensure!(options.mode!=Mode::Print,"print mode requires a prompt");
        let mut active:Option<tokio::task::JoinHandle<Result<()>>>=None;
        let mut rescan=false;
        loop{
            if active.is_none(){
                let line=tokio::select!{
                    line=lines.next_line()=>line?,
                    _=tokio::signal::ctrl_c()=>break,
                };
                let Some(line)=line else{drain(api.clone(),session.clone()).await?;break};let line=line.trim();
                if line=="/quit"{break}
                if line.is_empty(){continue}
                if let Err(error)=terminal_input(&api,&session,line,Timing::Now).await{
                    api.emit(Event::new(&scope,"command.result",json!({"error":error.to_string()}))).await?;continue
                }
                let api=api.clone();let session=session.clone();
                active=Some(tokio::spawn(async move{drain(api,session).await}));
            }else{
                tokio::select!{
                    result=active.as_mut().unwrap()=>{
                        if let Err(error)=result?{api.emit(Event::new(&scope,"command.result",json!({"error":error.to_string()}))).await?;}
                        active=None;
                        if rescan {
                            rescan=false;
                            let api=api.clone();let session=session.clone();
                            active=Some(tokio::spawn(async move{drain(api,session).await}));
                        }
                    },
                    _=tokio::signal::ctrl_c()=>{api.cancel(&session).await?;},
                    line=lines.next_line()=>{
                        let Some(line)=line? else{
                            if let Some(task)=active.take(){finish_eof(&api,&session,task).await?;}
                            drain(api.clone(),session.clone()).await?;break
                        };
                        if line=="/cancel"{api.cancel(&session).await?;continue}
                        if line=="/quit"{api.cancel(&session).await?;stop_jobs(&api,&session).await?;if let Some(task)=active.take(){let _=task.await?;}break}
                        let (text,timing)=if let Some(text)=line.strip_prefix("/after "){(text,Timing::After)}else{(line.as_str(),Timing::Steer)};
                        match terminal_input(&api,&session,text,timing).await{
                            Ok(_)=>rescan=true, // The worker may have settled just before admission.
                            Err(error)=>api.emit(Event::new(&scope,"command.result",json!({"error":error.to_string()}))).await?,
                        }
                    }
                }
            }
        }
        Ok(())
    }.await;
    requests(api.as_ref())?.presence(&session, "user", false);
    api.close(&session).await?;
    result
}
