//! Refuse malformed admissions and recovery records before returning a working view.
use super::*;

fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}

fn authority(data: &Value) -> bool {
    data["rights"]
        .as_array()
        .is_some_and(|rights| rights.iter().all(id))
        && data["authorizers"].as_array().is_some_and(|authors| {
            authors.iter().all(|a| {
                id(&a["sessionId"])
                    && (id(&a["actorId"]) && a.get("jobId").is_none()
                        || id(&a["jobId"]) && a.get("actorId").is_none())
            })
        })
}

pub(super) fn validate(meta: &Value, entries: &[Value]) -> Result<()> {
    let mut prior = BTreeMap::new();
    let mut starts = BTreeMap::new();
    let mut reports = BTreeMap::new();
    let mut head = None;
    let mut copied = meta.get("forkedFrom").is_some();
    for entry in entries {
        let kind = string(entry, "kind")?;
        let key = string(entry, "id")?;
        let d = &entry["data"];
        let erased = entry["erased"] == true;
        let job = entry["jobId"].as_str();
        if kind == "position" {
            ensure!(
                !erased && d["failed"].as_bool() != Some(true),
                "failed or erased position record"
            );
            ensure!(
                entry.get("parentId").is_some_and(|parent| match head {
                    Some(head) => parent.as_str() == Some(head),
                    None => parent.is_null(),
                }),
                "position does not follow the previous head"
            );
            ensure!(
                d.get("to").is_some_and(|to| to.is_null()
                    || to
                        .as_str()
                        .is_some_and(|to| prior.get(to).is_some_and(|&kind| kind != "position"))),
                "invalid position target"
            );
            ensure!(
                d.get("restore")
                    .is_none_or(|r| id(&r["point"]) && id(&r["undo"])),
                "invalid position restore intent"
            );
            head = d["to"].as_str();
        } else {
            head = Some(key);
        }
        ensure!(
            prior.insert(key, kind).is_none(),
            "duplicate history entry ID"
        );
        copied &= erased || entry["sources"].as_array().is_some_and(|s| !s.is_empty());
        if copied {
            continue;
        }
        if matches!(kind, "inputAccepted" | "inputHandedBack" | "input") {
            ensure!(id(&entry["inputId"]), "missing input identity");
        }
        if kind == "inputAccepted" && !erased {
            ensure!(
                id(&entry["actorId"])
                    && authority(d)
                    && d["content"].is_array()
                    && matches!(
                        d["when"].as_str(),
                        Some("now" | "after" | "steer" | "propose")
                    )
                    && (id(&d["releasedBy"])
                        || if job.is_some_and(|job| d["key"] == format!("job:{job}")) {
                            d["parked"].is_boolean()
                        } else {
                            matches!(
                                d["taken"].as_str(),
                                Some("now" | "after" | "inTurn" | "proposed")
                            )
                        }),
                "incomplete input admission"
            );
        }
        if kind == "jobStarted"
            && let Some(job) = job
        {
            starts.insert(job, entry);
        }
        if kind == "jobEnded" && !erased {
            let job = string(entry, "jobId")?;
            ensure!(
                starts.contains_key(job) && d["report"].is_boolean(),
                "incomplete job end"
            );
            if d["report"] == true {
                ensure!(
                    d["result"].is_array() && reports.insert(job, &d["result"]).is_none(),
                    "invalid job report"
                );
            }
        }
        if kind == "inputAccepted"
            && (erased || d.get("releasedBy").is_none())
            && let Some(job) = job
            && let Some(result) = reports.remove(job)
        {
            let start = starts[job];
            ensure!(
                erased
                    || (d["key"] == format!("job:{job}")
                        && d["when"] == "after"
                        && &d["content"] == result
                        && (start["erased"] == true || entry["actorId"] == start["actorId"])),
                "inconsistent job report admission"
            );
        }
    }
    ensure!(
        reports.is_empty(),
        "missing admission for a retained job report"
    );
    Ok(())
}
