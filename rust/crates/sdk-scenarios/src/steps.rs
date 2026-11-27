use super::scenario_answer;
use modular_agent::{Code, Error, Session, Timing, testing::fixtures};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, time::Duration};

#[derive(Default)]
pub(super) struct Bindings(HashMap<String, String>);

impl Bindings {
    fn resolve(&mut self, id: &mut Value, bind: Option<&str>, fail: &mut dyn FnMut(String)) {
        let Some(name) = id.as_str().filter(|s| s.starts_with('$')) else {
            return;
        };
        if let Some(value) = self.0.get(name) {
            *id = json!(value);
        } else if let Some(value) = bind {
            self.0.insert(name.into(), value.into());
            *id = json!(value);
        } else {
            fail(format!("input ID {name} has no original admission"));
        }
    }
}

pub(super) async fn perform(
    session: &Session,
    step: &Value,
    counter: &Path,
    bindings: &mut Bindings,
    fail: &mut impl FnMut(String),
) -> modular_agent::Result<Option<modular_agent::PromptResult>> {
    let session = match step["as"].as_str() {
        Some(actor) => session.r#as(actor)?,
        None => session.clone(),
    };
    if let Some(prompt) = step["prompt"].as_str() {
        return session.prompt(prompt).await.map(Some);
    }
    if let Some(input) = step["send"].as_str() {
        let timing = step
            .get("timing")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or(Timing::Now);
        let key = step["key"].as_str().map(str::to_owned);
        let receipt = session.send_with(input, timing, key).await?;
        if let Some(want) = step["expect"].get("receipt") {
            let mut want = want.clone();
            let bind = (want["duplicate"] == false
                && !receipt.duplicate
                && !receipt.erased
                && !receipt.input_id.is_empty())
            .then_some(receipt.input_id.as_str());
            bindings.resolve(&mut want["inputId"], bind, fail);
            let got = json!({"inputId":receipt.input_id, "taken":receipt.taken, "duplicate":receipt.duplicate});
            if receipt.erased || got != want {
                fail(format!(
                    "receipt: want non-erased {want}, got {}",
                    json!(receipt)
                ));
            }
        }
    } else if step["cancel"] == true {
        let got = json!(session.cancel().await?);
        if let Some(want) = step["expect"]["handedBack"].as_array() {
            let mut want = want.clone();
            for input in &mut want {
                bindings.resolve(&mut input["inputId"], None, fail);
            }
            let want = json!(want);
            if got != want {
                fail(format!("handedBack: want {want}, got {got}"));
            }
        }
    } else if let Some(count) = step["waitForCount"].as_u64() {
        tokio::time::timeout(Duration::from_secs(10), async {
            while fixtures::count(counter) < count {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| {
            Error::new(
                Code::Busy,
                format!("counter: want {count}, got {}", fixtures::count(counter)),
            )
        })?;
    } else if let Some(answer) = step.get("answer") {
        let answer = scenario_answer(answer)?;
        let question = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let mut open = session.questions()?;
                if open.len() == 1 {
                    return Ok::<_, Error>(open.remove(0));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| {
            Error::new(
                Code::Busy,
                "expected exactly one open question within 10 seconds",
            )
        })??;
        session.answer(&question.id, answer).await?;
    } else if step["wait"] == true {
        session.wait_idle().await?;
        return session.last_turn().await;
    } else {
        return Err(Error::new(Code::InvalidParams, "unknown scenario step"));
    }
    Ok(None)
}
