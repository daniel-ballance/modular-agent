use super::*;
#[test]
fn absent_annotations_are_conservative_and_raw_metadata_is_retained() -> Result<()> {
    let tool: Tool = serde_json::from_value(
        json!({"name":"probe","inputSchema":{"type":"object"},"outputSchema":{"type":"object"},"_meta":{"custom":"retained"}}),
    )?;
    let mapped = definition("server", &tool)?;
    assert!(!mapped.read_only && !mapped.safe_to_repeat && !mapped.parallel);
    assert_eq!(mapped.hints["destructive"], true);
    assert_eq!(mapped.hints["outside"], true);
    assert_eq!(mapped.hints["mcp"]["_meta"]["custom"], "retained");
    assert_eq!(
        mapped.hints["mcp"]["outputSchema"],
        json!({"type":"object"})
    );
    Ok(())
}
#[test]
fn names_are_unique_bounded_and_rejected_not_silently_rewritten() {
    assert!(tool_name("a__b", "c").is_err());
    assert!(tool_name("a", "b.c").is_err());
    assert!(tool_name("a", &"x".repeat(70)).is_err());
    assert_ne!(tool_name("ab", "c").unwrap(), tool_name("a", "bc").unwrap());
}
