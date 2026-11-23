mod support;
use agent_api::*;
use std::sync::Arc;
use support::Rig;

const LIMIT: usize = 4 << 20;

struct Gate {
    expand: bool,
}
impl Plugin for Gate {
    fn name(&self) -> &str {
        "test.held"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.declare(json!({"remote_output":true,"holds_output":true}));
        let expand = self.expand;
        r.on(
            "output.stream",
            Order::Normal,
            handler(move |_, _, mut v| {
                Box::pin(async move {
                    assert!(serde_json::to_vec(&v["events"])?.len() <= LIMIT);
                    if expand
                        && v["events"][0]["data"]["delta"]
                            .as_str()
                            .is_some_and(|s| s.starts_with('b'))
                    {
                        v["events"][0]["data"]["delta"] = json!("z".repeat(LIMIT));
                    }
                    Ok(answer(v))
                })
            }),
        );
        Ok(())
    }
}

#[tokio::test]
async fn overflow_in_any_segment_blocks_the_stream_and_notifies_the_follower() -> Result<()> {
    for mode in ["segments", "oversized", "replacement"] {
        let rig = Rig::with(
            vec![],
            vec![Arc::new(Gate {
                expand: mode == "replacement",
            })],
            vec![],
            json!({}),
        )
        .await;
        let scope = Scope::session(&rig.id);
        rig.events.values.lock().unwrap().clear();
        for (letter, n) in [
            ("a", LIMIT / 2),
            (
                "b",
                if mode == "oversized" {
                    LIMIT
                } else {
                    LIMIT / 2
                },
            ),
        ] {
            let mut piece = Event::new(&scope, "model.delta", json!(letter.repeat(n)));
            piece.stream = Some("attempt".into());
            rig.h.emit(piece).await?;
        }
        assert!(rig.events.values.lock().unwrap().is_empty());
        let mut end = Event::new(&scope, "model.end", Value::Null);
        end.stream = Some("attempt".into());
        end.end = true;
        rig.h.emit(end).await?;
        let seen: Vec<_> = rig
            .events
            .values
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.kind.clone())
            .collect();
        if mode == "segments" {
            assert_eq!(seen, ["model.delta", "model.delta"]);
        } else {
            assert_eq!(seen, ["output.overflow"]);
        }
    }
    Ok(())
}
