use super::*;

impl Session {
    /// This actor's gated view of the recorded entries, oldest first.
    pub async fn history(&self) -> Result<Vec<Value>> {
        let harness = self.inner.harness.as_ref();
        base::require(harness, &base::Scope::session(&self.id), "watch")?;
        base::require(harness, &self.scope(), "watch")?;
        harness.reconcile_pending_erasure(&self.id).await?;
        self.require("watch")?;
        let data = self.snapshot()?;
        let mut rows = Vec::new();
        for e in data.entries.iter().filter(|e| e.writer != "rust.derived") {
            let row = base::portable::public_entry(e, &data)?;
            if let Some(view) = self.gate_entry(&e.scope, row).await? {
                rows.push(view);
            }
        }
        Ok(rows)
    }
    /// Erase kept entries and their known copies using the installed history store.
    pub async fn erase(&self, entries: Vec<String>) -> Result<crate::ErasureReport> {
        let harness = self.inner.harness.as_ref();
        base::require(harness, &base::Scope::session(&self.id), "erase")?;
        base::require(harness, &self.scope(), "erase")?;
        if harness.declaration()?["erasure"] != true {
            return Err(Error::new(
                Code::NotSupported,
                "history store does not support erasure",
            ));
        }
        if entries.is_empty() {
            return Err(Error::new(Code::InvalidParams, "entry ids are required"));
        }
        if harness.is_running(&self.id) {
            return Err(Error::new(Code::Busy, "erasure requires an idle session"));
        }
        let report = harness
            .erase(&self.scope(), entries.into_iter().collect())
            .await?;
        let mut out = crate::ErasureReport {
            out_of_reach: report.out_of_reach,
            ..Default::default()
        };
        for (session_id, id) in report
            .qualified
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
        {
            if session_id != self.id {
                out.out_of_reach.push("copies in other sessions".into());
                continue;
            }
            let pair = crate::ErasedEntry { session_id, id };
            if report.pending.contains(&pair.id) {
                out.pending.push(pair);
            } else {
                out.erased.push(pair);
            }
        }
        out.out_of_reach.sort();
        out.out_of_reach.dedup();
        Ok(out)
    }
}
