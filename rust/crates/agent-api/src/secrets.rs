//! Durable staging state for local credential stores. The containing store must
//! commit this state and the active answers in one atomic transaction.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretRequest {
    pub session: String,
    pub request: String,
}

impl SecretRequest {
    fn key(&self) -> String {
        json!([self.session, self.request]).to_string()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagingReceipt {
    pub request: SecretRequest,
    pub name: String,
    pub actor: String,
    pub answer_session: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Activation {
    Activated,
    Superseded,
}

#[derive(Default, Serialize, Deserialize)]
pub struct SecretJournal {
    generation: BTreeMap<String, u64>,
    requests: BTreeMap<String, Stage>,
}

#[derive(Serialize, Deserialize)]
enum Stage {
    Waiting {
        receipt: StagingReceipt,
        value: String,
        generation: u64,
    },
    Decided {
        receipt: StagingReceipt,
        decision: Activation,
    },
    Discarded,
}

impl SecretJournal {
    pub fn is_empty(&self) -> bool {
        self.requests.is_empty() && self.generation.is_empty()
    }

    pub fn stage(&mut self, receipt: StagingReceipt, value: &str) -> Result<()> {
        let key = receipt.request.key();
        ensure!(
            !self.requests.contains_key(&key),
            "secret request already staged or discarded"
        );
        let generation = self
            .generation
            .get(&receipt.name)
            .copied()
            .unwrap_or_default();
        self.requests.insert(
            key,
            Stage::Waiting {
                receipt,
                value: value.into(),
                generation,
            },
        );
        Ok(())
    }

    pub fn lookup(&self, request: &SecretRequest) -> Option<StagingReceipt> {
        match self.requests.get(&request.key())? {
            Stage::Waiting { receipt, .. } | Stage::Decided { receipt, .. } => {
                Some(receipt.clone())
            }
            Stage::Discarded => None,
        }
    }

    pub fn activate(
        &mut self,
        request: &SecretRequest,
        answers: &mut BTreeMap<String, String>,
    ) -> Result<Activation> {
        let key = request.key();
        let (receipt, value, generation) = match self.requests.get(&key) {
            Some(Stage::Decided { decision, .. }) => return Ok(*decision),
            Some(Stage::Waiting {
                receipt,
                value,
                generation,
            }) => (receipt.clone(), value.clone(), *generation),
            _ => bail!("secret stage unavailable"),
        };
        let decision = if self
            .generation
            .get(&receipt.name)
            .copied()
            .unwrap_or_default()
            == generation
        {
            self.replace(answers, &receipt.name, Some(value))?;
            Activation::Activated
        } else {
            Activation::Superseded
        };
        self.requests
            .insert(key, Stage::Decided { receipt, decision });
        Ok(decision)
    }

    pub fn discard(&mut self, request: &SecretRequest) {
        let key = request.key();
        if !matches!(self.requests.get(&key), Some(Stage::Decided { .. })) {
            self.requests.insert(key, Stage::Discarded);
        }
    }

    pub fn replace(
        &mut self,
        answers: &mut BTreeMap<String, String>,
        name: &str,
        value: Option<String>,
    ) -> Result<()> {
        let generation = self.generation.entry(name.into()).or_default();
        *generation = generation
            .checked_add(1)
            .ok_or_else(|| anyhow!("credential generation exhausted"))?;
        if let Some(value) = value {
            answers.insert(name.into(), value);
        } else {
            answers.remove(name);
        }
        Ok(())
    }
}
