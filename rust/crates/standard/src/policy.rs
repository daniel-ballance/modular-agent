use anyhow::{Context, Result, bail, ensure};
use modular_agent::{AcpActor, AcpOptions, Actor, Capacity, ResourceLimits, Rights};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    stdio: Option<Principal>,
    actors: Option<Vec<NetworkPrincipal>>,
    limits: Option<LimitOverrides>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NetworkPrincipal {
    token_file: PathBuf,
    client_id: Option<String>,
    actor: PolicyActor,
    tenants: Option<Vec<Option<String>>>,
    projects: Option<Vec<PathBuf>>,
    #[serde(default)]
    represents: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Principal {
    actor: PolicyActor,
    tenants: Option<Vec<Option<String>>>,
    projects: Option<Vec<PathBuf>>,
    #[serde(default)]
    represents: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyActor {
    id: String,
    kind: String,
    rights: Vec<String>,
}

impl PolicyActor {
    fn validate(&self) -> Result<()> {
        ensure!(
            !self.id.is_empty() && !self.id.starts_with("job:"),
            "invalid actor ID"
        );
        ensure!(
            matches!(self.kind.as_str(), "user" | "host" | "agent" | "program"),
            "invalid actor kind"
        );
        ensure!(
            self.rights.iter().all(|right| Rights::full().has(right)),
            "unknown actor right"
        );
        Ok(())
    }
    fn into_actor(self) -> Actor {
        Actor {
            id: self.id,
            kind: self.kind,
            rights: Rights::only(&self.rights.iter().map(String::as_str).collect::<Vec<_>>()),
        }
    }
}

fn validate_scope(
    projects: Option<&mut Vec<PathBuf>>,
    tenants: Option<&[Option<String>]>,
    represents: &[String],
) -> Result<()> {
    ensure!(represents.is_empty(), "ma does not support representation");
    ensure!(
        tenants
            .into_iter()
            .flatten()
            .flatten()
            .all(|tenant| !tenant.is_empty()),
        "empty tenant ID"
    );
    for project in projects.into_iter().flatten() {
        ensure!(
            project.is_absolute(),
            "project path must be absolute: {}",
            project.display()
        );
        let canonical = project
            .canonicalize()
            .with_context(|| format!("invalid project path: {}", project.display()))?;
        ensure!(
            canonical.is_dir(),
            "project path is not a directory: {}",
            project.display()
        );
        *project = canonical;
    }
    Ok(())
}

impl Policy {
    pub async fn read(path: &Path, required: bool) -> Result<Self> {
        let read = async {
            let file = match std::fs::read(path) {
                Ok(file) => file,
                Err(e) if !required && e.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Self::default());
                }
                Err(e) => return Err(e.into()),
            };
            let mut policy: Self =
                serde_json::from_slice(&file).context("invalid stdio, actors or limits object")?;
            policy.bounds()?;
            if let Some(stdio) = &mut policy.stdio {
                stdio.actor.validate()?;
                validate_scope(
                    stdio.projects.as_mut(),
                    stdio.tenants.as_deref(),
                    &stdio.represents,
                )?;
            }
            if let Some(actors) = &mut policy.actors {
                ensure!(!actors.is_empty(), "actors is empty");
                for network in actors.iter_mut() {
                    network.actor.validate()?;
                    validate_scope(
                        network.projects.as_mut(),
                        network.tenants.as_deref(),
                        &network.represents,
                    )?;
                    network.token_file = path
                        .parent()
                        .unwrap_or(Path::new("."))
                        .join(&network.token_file);
                }
                modular_agent::validate_acp_token_files(
                    actors.iter().map(|actor| actor.token_file.as_path()),
                )
                .await?;
            }
            Ok(policy)
        };
        read.await
            .with_context(|| format!("policy {}", path.display()))
    }

    pub fn named_tenants(&self) -> bool {
        let named = |tenants: Option<&Vec<Option<String>>>| {
            tenants.into_iter().flatten().any(Option::is_some)
        };
        self.stdio
            .as_ref()
            .is_some_and(|p| named(p.tenants.as_ref()))
            || self
                .actors
                .iter()
                .flatten()
                .any(|p| named(p.tenants.as_ref()))
    }

    pub fn stdio(&mut self) -> AcpOptions {
        match self.stdio.take() {
            Some(p) => AcpOptions {
                actor: Some(p.actor.into_actor()),
                tenants: p.tenants,
                projects: p.projects,
                ..Default::default()
            },
            None => AcpOptions::default(),
        }
    }

    pub fn agui_clients(&self) -> Result<Vec<String>> {
        match &self.actors {
            None => Ok(vec!["ma-local".into()]),
            Some(actors) => actors
                .iter()
                .map(|p| {
                    p.client_id
                        .clone()
                        .filter(|s| !s.is_empty())
                        .context("AG-UI policy actor requires clientId")
                })
                .collect(),
        }
    }

    pub fn network(&mut self, shorthand: Option<PathBuf>) -> Result<Vec<AcpActor>> {
        match (self.actors.take(), shorthand) {
            (Some(_), Some(_)) => {
                bail!("--token-file cannot be combined with a policy actors list")
            }
            (None, None) => bail!("--listen requires policy actors or --token-file"),
            (None, Some(path)) => Ok(vec![AcpActor::local(path)]),
            (Some(actors), None) => Ok(actors
                .into_iter()
                .map(|p| AcpActor {
                    token_file: p.token_file,
                    actor: p.actor.into_actor(),
                    tenants: p.tenants,
                    projects: p.projects,
                    represents: p.represents,
                })
                .collect()),
        }
    }

    pub fn bounds(&self) -> Result<Bounds> {
        let mut bounds = Bounds::default();
        if let Some(overrides) = &self.limits {
            overrides.session.apply(&mut bounds.session)?;
            overrides.tenant.apply(&mut bounds.tenant)?;
            overrides.agent.apply(&mut bounds.agent)?;
        }
        Ok(bounds)
    }
}

#[derive(Clone, Serialize)]
pub struct Bounds {
    session: Bound,
    tenant: Bound,
    agent: Bound,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bound {
    #[serde(flatten)]
    counts: Capacity,
    buffered_bytes: u64,
    storage_bytes: u64,
    control_bytes: u64,
}

const MIB: u64 = 1024 * 1024;
const MAX_COUNT: u64 = 9_007_199_254_740_991;

impl Default for Bounds {
    fn default() -> Self {
        let bound = |inputs, calls, jobs, buffered, storage, control| Bound {
            counts: Capacity {
                inputs,
                calls,
                jobs,
            },
            buffered_bytes: buffered * MIB,
            storage_bytes: storage * MIB,
            control_bytes: control * MIB,
        };
        Self {
            session: bound(32, 64, 16, 16, 1024, 8),
            tenant: bound(128, 256, 64, 64, 8192, 32),
            agent: bound(512, 1024, 256, 256, 32768, 128),
        }
    }
}

impl Bounds {
    pub fn bytes(&self) -> modular_agent::ByteLimits {
        let capacity = |bound: &Bound| modular_agent::ByteCapacity {
            buffered: bound.buffered_bytes,
            storage: bound.storage_bytes,
            control: bound.control_bytes,
        };
        modular_agent::ByteLimits {
            session: capacity(&self.session),
            tenant: capacity(&self.tenant),
            agent: capacity(&self.agent),
        }
    }

    pub fn counts(&self) -> ResourceLimits {
        ResourceLimits {
            session: self.session.counts,
            tenant: self.tenant.counts,
            agent: self.agent.counts,
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct LimitOverrides {
    session: Override,
    tenant: Override,
    agent: Override,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Override {
    inputs: Option<u64>,
    calls: Option<u64>,
    jobs: Option<u64>,
    buffered_bytes: Option<u64>,
    storage_bytes: Option<u64>,
    control_bytes: Option<u64>,
}
impl Override {
    fn apply(&self, bound: &mut Bound) -> Result<()> {
        let count = |value: Option<u64>, default| -> Result<u64> {
            let value = value.unwrap_or(default);
            ensure!(value <= MAX_COUNT, "limit exceeds maximum Count");
            Ok(value)
        };
        bound.counts.inputs = count(self.inputs, bound.counts.inputs as u64)?.try_into()?;
        bound.counts.calls = count(self.calls, bound.counts.calls as u64)?.try_into()?;
        bound.counts.jobs = count(self.jobs, bound.counts.jobs as u64)?.try_into()?;
        bound.buffered_bytes = count(self.buffered_bytes, bound.buffered_bytes)?;
        bound.storage_bytes = count(self.storage_bytes, bound.storage_bytes)?;
        bound.control_bytes = count(self.control_bytes, bound.control_bytes)?;
        ensure!(
            bound.control_bytes <= bound.storage_bytes,
            "controlBytes exceeds storageBytes"
        );
        Ok(())
    }
}
