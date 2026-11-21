//! Operator options for the disposable base-agent conformance launch.
use agent_api::*;
use agent_harness::ResourceLimits;
use anyhow::Context as _;
use interface_acp::Identity;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    stdio: Principal,
    #[serde(default)]
    limits: ResourceLimits,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Principal {
    actor: Actor,
    projects: Option<Vec<PathBuf>>,
    tenants: Option<Vec<Option<String>>>,
    #[serde(default)]
    represents: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Actor {
    id: String,
    kind: String,
    rights: Vec<String>,
}

pub fn load() -> Result<Option<(Identity, ResourceLimits)>> {
    if std::env::var("MODULAR_AGENT_CONFORMANCE").as_deref() != Ok("1") {
        return Ok(None);
    }
    let Some(path) = std::env::var_os("MODULAR_AGENT_CONFORMANCE_POLICY").map(PathBuf::from) else {
        return Ok(None);
    };
    read(&path)
        .map(Some)
        .with_context(|| format!("policy {}", path.display()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginHost {
    token_file: PathBuf,
    project: PathBuf,
    state: PathBuf,
}

type PluginHosts = Vec<(PathBuf, (PathBuf, PathBuf))>;

pub fn plugin_hosts(path: &std::path::Path) -> Result<PluginHosts> {
    let read = || -> Result<_> {
        let hosts: Vec<PluginHost> = serde_json::from_slice(&std::fs::read(path)?)?;
        ensure!(!hosts.is_empty(), "at least one host is required");
        let relative = |p: PathBuf| path.parent().unwrap_or(std::path::Path::new(".")).join(p);
        let overlap =
            |a: &std::path::Path, b: &std::path::Path| a.starts_with(b) || b.starts_with(a);
        let mut entries: PluginHosts = Vec::new();
        for host in hosts {
            let project = relative(host.project).canonicalize()?;
            let state = relative(host.state).canonicalize()?;
            ensure!(
                project.is_dir() && state.is_dir(),
                "host project and state must be directories"
            );
            ensure!(
                !overlap(&project, &state)
                    && !entries.iter().any(|(_, (p, s))| {
                        overlap(p, &project)
                            || overlap(p, &state)
                            || overlap(s, &project)
                            || overlap(s, &state)
                    }),
                "host projects and state must not overlap"
            );
            entries.push((relative(host.token_file), (project, state)));
        }
        Ok(entries)
    };
    read().with_context(|| format!("host policy {}", path.display()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpHost {
    token_file: PathBuf,
    #[serde(flatten)]
    principal: Principal,
}
pub fn network() -> Result<(Vec<(PathBuf, Identity)>, ResourceLimits)> {
    ensure!(
        std::env::var("MODULAR_AGENT_CONFORMANCE").as_deref() == Ok("1"),
        "ACP policy listener is a conformance option"
    );
    let path = std::env::var_os("MODULAR_AGENT_CONFORMANCE_POLICY")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("missing ACP policy"))?;
    let read = || -> Result<_> {
        let mut raw: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        let hosts: Vec<AcpHost> =
            serde_json::from_value(raw["actors"].take()).context("actors must be a list")?;
        ensure!(!hosts.is_empty(), "at least one actor is required");
        let limits = if raw["limits"].is_null() {
            ResourceLimits::default()
        } else {
            serde_json::from_value(raw["limits"].take())?
        };
        let base = path.parent().unwrap_or(std::path::Path::new("."));
        let mut entries = Vec::new();
        for host in hosts {
            let mut identity = identity(host.principal)?;
            identity.network = true;
            identity.join_on_open = false;
            entries.push((base.join(host.token_file), identity));
        }
        Ok((entries, limits))
    };
    read().with_context(|| format!("policy {}", path.display()))
}

fn read(path: &std::path::Path) -> Result<(Identity, ResourceLimits)> {
    let raw: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        raw.get("actors").is_none(),
        "base stdio policy does not accept actors"
    );
    ensure!(
        raw["stdio"].get("projects").is_none_or(|p| p.is_array()),
        "stdio.projects must be a list"
    );
    let Policy { stdio, limits } = serde_json::from_value(raw)?;
    Ok((identity(stdio)?, limits))
}

fn identity(mut p: Principal) -> Result<Identity> {
    let actor_id = |id: &str| !id.is_empty() && !id.starts_with("job:");
    ensure!(
        actor_id(&p.actor.id) && p.represents.iter().all(|id| actor_id(id)),
        "invalid actor ID"
    );
    ensure!(
        matches!(p.actor.kind.as_str(), "user" | "host" | "agent" | "program"),
        "invalid actor kind"
    );
    ensure!(
        p.actor
            .rights
            .iter()
            .all(|right| Authority::full().has(right)),
        "invalid actor right"
    );
    ensure!(
        p.tenants
            .iter()
            .flatten()
            .flatten()
            .all(|tenant| !tenant.is_empty()),
        "empty tenant ID"
    );
    for project in p.projects.iter_mut().flatten() {
        ensure!(
            project.is_absolute(),
            "project path must be absolute: {}",
            project.display()
        );
        *project = project
            .canonicalize()
            .with_context(|| format!("invalid project {}", project.display()))?;
        ensure!(
            project.is_dir(),
            "project is not a directory: {}",
            project.display()
        );
    }
    Ok(Identity {
        id: p.actor.id,
        kind: p.actor.kind,
        rights: Authority::only(
            &p.actor
                .rights
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        ),
        tenants: p.tenants,
        projects: p.projects,
        represents: p.represents,
        explicit_rights: true,
        join_on_open: true,
        network: false,
    })
}
