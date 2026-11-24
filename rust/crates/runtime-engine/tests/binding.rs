use agent_api::*;
use runtime_engine::binding::{self, Host};
use std::sync::Mutex;

struct HistoryHost {
    next: Value,
    hooks: Mutex<Vec<Value>>,
}

#[async_trait]
impl Host for HistoryHost {
    async fn ask(&self, method: &str, params: Value, _: bool) -> Result<Value> {
        match method {
            "hasSteering" => Ok(json!({"waiting":false})),
            "takeSteering" if params["final"] == true => Ok(json!({"entries":[]})),
            "hook" => {
                self.hooks.lock().unwrap().push(params);
                Ok(Value::Null)
            }
            _ => panic!("unexpected callback {method}"),
        }
    }
    async fn history(&self, session: &Value, after: Option<&Value>) -> Result<Value> {
        assert_eq!(*session, "session");
        assert!(after.is_none(), "read beyond the last history page");
        Ok(self.next.clone())
    }
    fn cancelled(&self) -> bool {
        false
    }
    fn entries(&self) -> Value {
        json!([])
    }
}

#[tokio::test]
async fn served_runtime_treats_null_next_as_the_last_history_page() {
    for explicit_null in [false, true] {
        let mut page = json!({"entries":[
            {"kind":"modelRequest","turnId":"turn","stepId":"step","data":{"tools":[]}},
            {"kind":"response","turnId":"turn","stepId":"step",
                "message":{"role":"assistant","content":[{"type":"text","text":"kept"}],"stop":"finished","usage":null}},
            {"kind":"modular-agent.stepAfter","turnId":"turn","stepId":"step","data":{"decision":null}}
        ]});
        if explicit_null {
            page["next"] = Value::Null;
        }
        let host = HistoryHost {
            next: page,
            hooks: Mutex::default(),
        };
        let reply = binding::run(&host, "runtime/resumeTurn", json!({"turn":{"sessionId":"session","turnId":"turn"},"interrupted":{"turnId":"turn","calls":[],"lastStep":{"stepId":"step","decision":null}}}), true).await.unwrap();
        assert_eq!(reply["outcome"]["kind"], "completed");
        assert_eq!(reply["result"]["text"], "kept");
        assert!(
            host.hooks
                .lock()
                .unwrap()
                .iter()
                .all(|p| p["hook"] != "step.after")
        );
        assert_eq!(
            host.hooks.lock().unwrap().last().unwrap(),
            &json!({"hook":"turn.end","stepId":null,"payload":{"outcome":{"kind":"completed"},"result":{"text":"kept","openToolCalls":[]},"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0.0}}})
        );
    }
}
