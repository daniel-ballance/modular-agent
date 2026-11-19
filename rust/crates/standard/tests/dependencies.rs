//! The public SDK is the only route from ma or its plugins into the base.
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, process::Command};

#[test]
fn no_product_or_tool_plugin_dependency_bypasses_the_sdk() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--locked",
            "--manifest-path",
        ])
        .arg(root)
        .output()
        .expect("run cargo metadata");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: Value = serde_json::from_slice(&output.stdout).unwrap();
    let members: BTreeMap<_, _> = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["name"].as_str().unwrap(), p))
        .collect();

    let permits: BTreeMap<_, &[&str]> = BTreeMap::from([
        (
            "standard",
            &[
                "modular-agent",
                "modular-agent-files",
                "modular-agent-mcp",
                "provider-responses",
                "credentials-auth",
                "tools-code",
            ][..],
        ),
        ("modular-agent-files", &["modular-agent"]),
        ("modular-agent-mcp", &["modular-agent", "mcp-client"]),
        ("provider-responses", &["modular-agent", "credentials-auth"]),
        ("credentials-auth", &["modular-agent"]),
        ("tools-code", &["modular-agent"]),
        ("mcp-client", &[]),
    ]);
    for (name, allowed) in permits {
        let dependencies = members[name]["dependencies"].as_array().unwrap();
        let paths: Vec<_> = dependencies
            .iter()
            .filter(|d| d["path"].is_string())
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        assert_eq!(paths.len(), allowed.len(), "{name}: {paths:?}");
        for dep in paths {
            assert!(
                allowed.contains(&dep),
                "{name} depends on {dep} outside its allowed SDK boundary"
            );
        }
    }
}
