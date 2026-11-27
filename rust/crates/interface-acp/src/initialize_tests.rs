use super::*;

struct TestFactory;

#[async_trait]
impl Factory for TestFactory {
    async fn declaration(&self) -> Result<Value> {
        Ok(json!({}))
    }
    async fn build(&self, _project: &Path, _sink: Arc<dyn EventSink>) -> Result<Api> {
        unreachable!()
    }
    fn list(&self, _project: Option<&Path>) -> Result<Vec<SessionData>> {
        Ok(vec![])
    }
    fn trust(&self, _project: &Path) -> Result<()> {
        unreachable!()
    }
    async fn attach(
        &self,
        _api: Api,
        _session: &str,
        _project: &Path,
        _servers: Value,
    ) -> Result<()> {
        unreachable!()
    }
    async fn detach(&self, _api: Api, _session: &str) {
        unreachable!()
    }
}

async fn probe(work: impl AsyncFnOnce(ConnectionTo<acp::Agent>) -> acp::Result<()>) {
    let (agent, client) = acp::Channel::duplex();
    let server = run_connection(
        Arc::new(TestFactory),
        Identity::local(),
        Arc::default(),
        agent,
        Arc::default(),
    );
    let client = acp::Builder::new(acp::Client).connect_with(client, work);
    let (server, client) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(server, client)
    })
    .await
    .expect("ACP probe did not finish");
    client.unwrap();
    server.unwrap();
}

async fn request(cx: &ConnectionTo<acp::Agent>, method: &str, params: Value) -> acp::Result<Value> {
    cx.send_request(UntypedMessage::new(method, params)?)
        .block_task()
        .await
}

#[tokio::test]
async fn negotiate_protocol_version_independently_of_binding() {
    for (version, binding) in [
        (json!(2), Some("modular-agent-acp/1")),
        (json!(2), Some("modular-agent-acp/2")),
        (json!(2.0), Some("modular-agent-acp/2")),
        (json!(65535), None),
    ] {
        probe(async |cx| {
            let mut params = json!({"protocolVersion":version});
            if let Some(binding) = binding {
                params["_meta"] = json!({"modular-agent":{"binding":binding}});
            }
            let hello = request(&cx, "initialize", params).await?;
            assert_eq!(hello["protocolVersion"], 1);
            assert_eq!(
                hello["_meta"]["modular-agent"]["binding"],
                binding.unwrap_or("modular-agent-acp/1")
            );
            Ok(())
        })
        .await;
    }
}

#[tokio::test]
async fn failed_initialize_leaves_connection_uninitialized() {
    probe(async |cx| {
        let mut invalid = vec![
            (json!({}), None),
            (json!({"protocolVersion":0}), Some("unsupported_version")),
            (
                json!({"protocolVersion":2,"_meta":{"modular-agent":{"binding":"modular-agent-acp/3"}}}),
                Some("unsupported_version"),
            ),
        ];
        for version in [json!("1"), json!(1.5), json!(-1), json!(65536), json!(true), Value::Null, json!({}), json!([])] {
            invalid.push((json!({"protocolVersion":version}), None));
        }
        for namespace in [Value::Null, json!([]), json!({"binding":2})] {
            invalid.push((
                json!({"protocolVersion":2,"_meta":{"modular-agent":namespace}}),
                Some("invalid_params"),
            ));
        }
        for (params, code) in invalid {
            let error = request(&cx, "initialize", params.clone())
                .await
                .expect_err(&format!("initialize accepted {params}"));
            assert_eq!(i32::from(error.code), -32602, "{params}: {error:?}");
            if let Some(code) = code {
                assert_eq!(error.data, Some(json!({"code":code})), "{params}");
            }
            let list = request(&cx, "session/list", json!({})).await.unwrap_err();
            assert_eq!(i32::from(list.code), -32602);
            assert_eq!(list.data, Some(json!({"code":"not_initialized"})));
        }
        let hello = request(&cx, "initialize", json!({"protocolVersion":2})).await?;
        assert_eq!(hello["protocolVersion"], 1);
        let list = request(&cx, "session/list", json!({})).await?;
        assert_eq!(list["sessions"], json!([]));
        Ok(())
    })
    .await;
}
