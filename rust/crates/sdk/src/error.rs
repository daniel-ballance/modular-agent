//! Errors: a stable code to branch on and a message for people (docs/sdk/api.md#errors).
use serde_json::Value;
use std::fmt;

/// What went wrong, as a value a program can branch on. Never branch on the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Code {
    InvalidParams,
    InvalidRequest,
    InvalidComposition,
    Forbidden,
    NotFound,
    NotOpen,
    Busy,
    Unavailable,
    Held,
    Conflict,
    Cancelled,
    NotSupported,
    TurnLimit,
    UnknownHandler,
    Withheld,
    ResultTooLarge,
    MessageTooLarge,
    Lost,
    Internal,
}

impl Code {
    /// The code as the bindings spell it, such as `invalid_composition`.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::InvalidParams => "invalid_params",
            Code::InvalidRequest => "invalid_request",
            Code::InvalidComposition => "invalid_composition",
            Code::Forbidden => "forbidden",
            Code::NotFound => "not_found",
            Code::NotOpen => "not_open",
            Code::Busy => "busy",
            Code::Unavailable => "unavailable",
            Code::Held => "held",
            Code::Conflict => "conflict",
            Code::Cancelled => "cancelled",
            Code::NotSupported => "not_supported",
            Code::TurnLimit => "turn_limit",
            Code::UnknownHandler => "unknown_handler",
            Code::Withheld => "withheld",
            Code::ResultTooLarge => "result_too_large",
            Code::MessageTooLarge => "message_too_large",
            Code::Lost => "lost",
            Code::Internal => "internal",
        }
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An SDK error.
#[derive(Debug)]
pub struct Error {
    code: Code,
    message: String,
    data: Option<Value>,
    /// Set only by `ToolContext::refuse`: the call ends `refused`, not `failed`.
    pub(crate) refusal: bool,
    pub(crate) left_open: bool,
}

impl Error {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
            refusal: false,
            left_open: false,
        }
    }
    /// A failure with code `internal`, for a tool or plugin to raise.
    pub fn msg(message: impl Into<String>) -> Self {
        Self::new(Code::Internal, message)
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
    pub fn code(&self) -> Code {
        self.code
    }
    pub fn message(&self) -> &str {
        &self.message
    }
    pub fn data(&self) -> Option<&Value> {
        self.data.as_ref()
    }
    /// True when a timed ask suspended this invocation, rather than failing it.
    pub fn is_left_open(&self) -> bool {
        self.left_open
    }
    pub(crate) fn refusal(reason: impl Into<String>) -> Self {
        Self {
            refusal: true,
            ..Self::new(Code::Internal, reason)
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

/// Errors from the base build carry no code; only a typed cause can be mapped.
impl From<anyhow::Error> for Error {
    fn from(error: anyhow::Error) -> Self {
        if let Some(e) = error.downcast_ref::<Error>() {
            return Error {
                code: e.code,
                message: e.message.clone(),
                data: e.data.clone(),
                refusal: e.refusal,
                left_open: e.left_open,
            };
        }
        if let Some(held) = error.downcast_ref::<agent_api::HistoryHeld>() {
            return Error::new(Code::Held, held.to_string())
                .with_data(serde_json::json!({"retryAfterMs":held.retry_after_ms}));
        }
        if let Some(cause) = error.downcast_ref::<agent_api::OperationError>() {
            use agent_api::OperationError::*;
            let code = match cause {
                NotFound(_) => Code::NotFound,
                Busy(_) => Code::Busy,
                Unavailable(_) => Code::Unavailable,
                Forbidden(_) => Code::Forbidden,
                Conflict(_) => Code::Conflict,
                InvalidParams(_) => Code::InvalidParams,
                ResultTooLarge(_) => Code::ResultTooLarge,
            };
            return Error::new(code, format!("{error:#}"));
        }
        let code = if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::Unsupported)
        {
            Code::NotSupported
        } else if error.downcast_ref::<agent_api::LostPart>().is_some() {
            Code::Lost
        } else if agent_api::is_file_not_found(&error) {
            Code::NotFound
        } else {
            Code::Internal
        };
        Error::new(code, format!("{error:#}"))
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => Code::NotFound,
            std::io::ErrorKind::Unsupported => Code::NotSupported,
            _ => Code::Internal,
        };
        Error::new(code, error.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Error::new(Code::InvalidParams, error.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
