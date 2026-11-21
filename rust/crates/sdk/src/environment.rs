//! A working environment written against the plugin binding's operations.
use crate::{Code, Error, Result};
use agent_api as base;
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Containment {
    #[default]
    None,
    ProcessGroup,
    Strong,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDeclaration {
    pub containment: Containment,
    pub platforms: Vec<String>,
    pub points: bool,
    pub confines_files: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirEntryKind {
    File,
    Directory,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: DirEntryKind,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: Option<i64>,
    pub output: String,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Clone)]
pub struct EnvironmentContext {
    pub session_id: String,
    pub cwd: PathBuf,
    pub cancelled: CancellationToken,
    settled: CancellationToken,
    backend: Option<crate::tool::Backend>,
    output: Option<OutputSink>,
}
type OutputSink =
    Arc<dyn Fn(String) -> futures_util::future::BoxFuture<'static, Result<()>> + Send + Sync>;

impl EnvironmentContext {
    pub async fn emit(&self, kind: &str, data: Value) -> Result<()> {
        let backend = self
            .backend
            .as_ref()
            .filter(|_| !self.settled.is_cancelled())
            .ok_or_else(|| {
                Error::new(
                    Code::InvalidRequest,
                    "environment context has no active session",
                )
            })?;
        crate::context::emit(backend, &self.session_id, kind, data).await
    }
    pub fn log(&self, message: impl std::fmt::Display) {
        eprintln!("environment for {}: {message}", self.session_id);
    }
    /// Report a live exec output chunk; it is not the final ExecResult.
    pub async fn output(&self, chunk: impl Into<String>) -> Result<()> {
        if self.settled.is_cancelled() {
            return Err(Error::new(
                Code::InvalidRequest,
                "environment call has settled",
            ));
        }
        if self.cancelled.is_cancelled() {
            return Err(Error::new(
                Code::Cancelled,
                "environment call was cancelled",
            ));
        }
        let output = self
            .output
            .as_ref()
            .ok_or_else(|| Error::new(Code::InvalidRequest, "only exec reports output"))?;
        output(chunk.into()).await
    }
}

fn unsupported(what: &str) -> Error {
    Error::new(
        Code::NotSupported,
        format!("environment does not support {what}"),
    )
}

#[crate::async_trait]
pub trait EnvironmentPart: Send + Sync + 'static {
    fn declaration(&self) -> EnvironmentDeclaration;
    async fn read(&self, cx: EnvironmentContext, path: &str) -> Result<Vec<u8>>;
    async fn exists(&self, cx: EnvironmentContext, path: &str) -> Result<bool> {
        match self.read(cx, path).await {
            Ok(_) => Ok(true),
            Err(error) if error.code() == Code::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
    async fn write(&self, cx: EnvironmentContext, path: &str, bytes: &[u8]) -> Result<()>;
    async fn list(&self, _cx: EnvironmentContext, _path: &str) -> Result<Vec<DirEntry>> {
        Err(unsupported("directory listing"))
    }
    async fn exec(
        &self,
        cx: EnvironmentContext,
        command: &str,
        timeout: Option<Duration>,
    ) -> Result<ExecResult>;
    async fn save_point(&self, _cx: EnvironmentContext) -> Result<String> {
        Err(unsupported("points"))
    }
    async fn check_point(&self, _cx: EnvironmentContext, _point: &str) -> Result<bool> {
        Err(unsupported("points"))
    }
    async fn restore_point(&self, _cx: EnvironmentContext, _point: &str) -> Result<()> {
        Err(unsupported("points"))
    }
    async fn session_ended(&self, _session_id: &str) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct Adapter {
    pub part: Arc<dyn EnvironmentPart>,
    pub registration: EnvironmentDeclaration,
    work: Option<(base::Api, base::Scope, CancellationToken)>,
}
impl Adapter {
    pub fn new(part: impl EnvironmentPart) -> Self {
        Self {
            registration: part.declaration(),
            part: Arc::new(part),
            work: None,
        }
    }
    fn context(&self, cwd: &Path) -> EnvironmentContext {
        EnvironmentContext {
            cwd: cwd.into(),
            session_id: self
                .work
                .as_ref()
                .map(|(_, s, _)| s.session.clone())
                .unwrap_or_default(),
            cancelled: self
                .work
                .as_ref()
                .map(|(_, _, c)| c.clone())
                .unwrap_or_default(),
            settled: CancellationToken::new(),
            output: None,
            backend: self
                .work
                .as_ref()
                .map(|(api, scope, _)| crate::tool::Backend::Local {
                    api: api.clone(),
                    scope: scope.clone(),
                }),
        }
    }
    pub async fn serve(
        &self,
        peer: Arc<plugin_stdio::rpc::Peer>,
        id: Value,
        method: &str,
        p: Value,
        project: &Path,
        cancelled: CancellationToken,
    ) -> Result<Value> {
        let string = |key| {
            p[key]
                .as_str()
                .ok_or_else(|| Error::new(Code::InvalidRequest, format!("missing {key}")))
        };
        let session_id = string("sessionId")?;
        if method == "env/sessionEnded" {
            self.part.session_ended(session_id).await?;
            return Ok(json!({}));
        }
        let cwd = PathBuf::from(string("cwd")?);
        if !cwd.is_absolute()
            || !cwd.starts_with(project)
            || cwd
                .components()
                .any(|c| c == std::path::Component::ParentDir)
            || cwd
                .canonicalize()
                .is_ok_and(|real| !real.starts_with(project))
        {
            return Err(Error::new(
                Code::InvalidRequest,
                "cwd outside environment project",
            ));
        }
        if !self.registration.points
            && matches!(method, "env/save" | "env/checkPoint" | "env/restore")
        {
            return Err(unsupported("points"));
        }
        let mut cx = EnvironmentContext {
            cwd,
            session_id: session_id.into(),
            cancelled,
            settled: CancellationToken::new(),
            output: None,
            backend: Some(crate::tool::Backend::Remote {
                peer: peer.clone(),
                parent: id.clone(),
            }),
        };
        let _settle = cx.settled.clone().drop_guard();
        Ok(match method {
            "env/read" => {
                json!({"data":BASE64_STANDARD.encode(self.part.read(cx,string("path")?).await?)})
            }
            "env/exists" => json!({"exists":self.part.exists(cx,string("path")?).await?}),
            "env/write" => {
                let bytes = BASE64_STANDARD
                    .decode(string("data")?)
                    .map_err(|err| Error::new(Code::InvalidRequest, err.to_string()))?;
                self.part.write(cx, string("path")?, &bytes).await?;
                json!({})
            }
            "env/list" => json!({"entries":self.part.list(cx, string("path")?).await?}),
            "env/save" => json!({"point":self.part.save_point(cx).await?}),
            "env/checkPoint" => {
                json!({"exists":self.part.check_point(cx, string("point")?).await?})
            }
            "env/restore" => {
                self.part.restore_point(cx, string("point")?).await?;
                json!({})
            }
            "env/exec" => {
                let timeout = match p.get("timeoutMs") {
                    None | Some(Value::Null) => None,
                    Some(v) => {
                        let ms = v
                            .as_u64()
                            .filter(|ms| *ms <= 9_007_199_254_740_991)
                            .ok_or_else(|| Error::new(Code::InvalidRequest, "invalid timeout"))?;
                        (ms > 0).then(|| Duration::from_millis(ms))
                    }
                };
                cx.output = Some(Arc::new(move |chunk| {
                    peer.notify("env/output", json!({"parentRequestId":id,"chunk":chunk}));
                    Box::pin(async { Ok(()) })
                }));
                json!(self.part.exec(cx, string("command")?, timeout).await?)
            }
            _ => {
                return Err(Error::new(
                    Code::InvalidRequest,
                    "unknown environment method",
                ));
            }
        })
    }
}

fn native_error(error: Error) -> anyhow::Error {
    match error.code() {
        Code::NotFound => std::io::Error::new(std::io::ErrorKind::NotFound, error).into(),
        Code::NotSupported => std::io::Error::new(std::io::ErrorKind::Unsupported, error).into(),
        _ => error.into(),
    }
}

#[crate::async_trait]
impl base::WorkingEnvironment for Adapter {
    fn scoped(
        &self,
        api: base::Api,
        scope: base::Scope,
        cancel: CancellationToken,
    ) -> Option<Arc<dyn base::WorkingEnvironment>> {
        Some(Arc::new(Self {
            work: Some((api, scope, cancel)),
            ..self.clone()
        }))
    }
    fn declaration(&self) -> Value {
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            os => os,
        };
        let applies = self.registration.platforms.iter().any(|p| p == platform);
        let containment = if applies {
            self.registration.containment
        } else {
            Containment::None
        };
        json!({"containment":containment,"rewinding":self.registration.points,"confines_files":self.registration.confines_files,"stops_commands_after_sigkill":matches!(containment,Containment::Strong)})
    }
    async fn read(&self, cwd: &Path, path: &str) -> base::Result<String> {
        Ok(String::from_utf8(self.read_bytes(cwd, path).await?)?)
    }
    async fn read_bytes(&self, cwd: &Path, path: &str) -> base::Result<Vec<u8>> {
        let cx = self.context(cwd);
        let _settle = cx.settled.clone().drop_guard();
        self.part.read(cx, path).await.map_err(native_error)
    }
    async fn exists(&self, cwd: &Path, path: &str) -> base::Result<bool> {
        let cx = self.context(cwd);
        let _settle = cx.settled.clone().drop_guard();
        self.part.exists(cx, path).await.map_err(native_error)
    }
    async fn write(&self, cwd: &Path, path: &str, text: &str) -> base::Result<()> {
        self.write_bytes(cwd, path, text.as_bytes()).await
    }
    async fn write_bytes(&self, cwd: &Path, path: &str, bytes: &[u8]) -> base::Result<()> {
        let cx = self.context(cwd);
        let _settle = cx.settled.clone().drop_guard();
        self.part.write(cx, path, bytes).await.map_err(native_error)
    }
    async fn list_dir(&self, cwd: &Path, path: &str) -> base::Result<Vec<String>> {
        let cx = self.context(cwd);
        let _settle = cx.settled.clone().drop_guard();
        Ok(self
            .part
            .list(cx, path)
            .await
            .map_err(native_error)?
            .into_iter()
            .map(|entry| {
                if matches!(entry.kind, DirEntryKind::Directory) {
                    format!("{}/", entry.name)
                } else {
                    entry.name
                }
            })
            .collect())
    }
    async fn edit(&self, cwd: &Path, path: &str, old: &str, new: &str) -> base::Result<()> {
        let text = self.read(cwd, path).await?;
        base::ensure!(text.matches(old).count() == 1, "expected one match");
        self.write(cwd, path, &text.replacen(old, new, 1)).await
    }
    async fn save_point(&self, session: &str, cwd: &Path) -> base::Result<String> {
        let cx = EnvironmentContext {
            session_id: session.into(),
            ..self.context(cwd)
        };
        let _settle = cx.settled.clone().drop_guard();
        self.part.save_point(cx).await.map_err(native_error)
    }
    async fn check_point(&self, session: &str, cwd: &Path, point: &str) -> base::Result<bool> {
        let cx = EnvironmentContext {
            session_id: session.into(),
            ..self.context(cwd)
        };
        let _settle = cx.settled.clone().drop_guard();
        self.part.check_point(cx, point).await.map_err(native_error)
    }
    async fn restore_point(&self, session: &str, cwd: &Path, point: &str) -> base::Result<()> {
        let cx = EnvironmentContext {
            session_id: session.into(),
            ..self.context(cwd)
        };
        let _settle = cx.settled.clone().drop_guard();
        self.part
            .restore_point(cx, point)
            .await
            .map_err(native_error)
    }
    async fn session_ended(&self, session: &str) -> base::Result<()> {
        self.part.session_ended(session).await.map_err(native_error)
    }
    async fn bash(
        &self,
        api: base::Api,
        scope: base::Scope,
        cwd: PathBuf,
        command: &str,
        cancel: CancellationToken,
    ) -> base::Result<base::ToolResult> {
        self.exec(api, scope, cwd, command, None, cancel).await
    }
    async fn exec(
        &self,
        api: base::Api,
        scope: base::Scope,
        cwd: PathBuf,
        command: &str,
        timeout: Option<Duration>,
        cancelled: CancellationToken,
    ) -> base::Result<base::ToolResult> {
        let call = scope.call.clone().unwrap_or_default();
        let cx = EnvironmentContext {
            session_id: scope.session.clone(),
            cwd,
            cancelled: cancelled.clone(),
            settled: CancellationToken::new(),
            backend: Some(crate::tool::Backend::Local {
                api: api.clone(),
                scope: scope.clone(),
            }),
            output: Some(Arc::new(move |chunk| {
                let api = api.clone();
                let scope = scope.clone();
                Box::pin(async move {
                    Ok(api
                        .emit(base::Event::new(&scope, "tool.progress", json!(chunk)))
                        .await?)
                })
            })),
        };
        let _settle = cx.settled.clone().drop_guard();
        let result = self
            .part
            .exec(cx, command, timeout)
            .await
            .map_err(native_error)?;
        Ok(base::ToolResult {
            call,
            status: if cancelled.is_cancelled() {
                base::ToolStatus::Cancelled
            } else if result.exit_code == Some(0) && !result.timed_out {
                base::ToolStatus::Completed
            } else {
                base::ToolStatus::Failed
            },
            text: result.output,
            value: Some(
                json!({"exit_code":result.exit_code,"timed_out":result.timed_out,"truncated":result.truncated}),
            ),
        })
    }
}
