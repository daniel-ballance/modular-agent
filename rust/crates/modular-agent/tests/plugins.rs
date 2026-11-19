use agent_api::*;
use agent_harness::Harness;
use std::sync::Arc;

struct Owner {
    point: std::sync::Mutex<Option<HookPoint>>,
    rule: Rule,
}
impl Plugin for Owner {
    fn name(&self) -> &str {
        "owner"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        *self.point.lock().unwrap() = Some(r.define("custom", self.rule)?);
        Ok(())
    }
}
struct Listener {
    name: &'static str,
    order: Order,
    suffix: &'static str,
    refuse: bool,
}
impl Plugin for Listener {
    fn name(&self) -> &str {
        self.name
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let suffix = self.suffix;
        let refuse = self.refuse;
        r.on(
            "custom",
            self.order,
            handler(move |_, _, v| {
                Box::pin(async move {
                    if refuse {
                        bail!("no")
                    }
                    Ok(answer(json!(format!(
                        "{}{suffix}",
                        v.as_str().unwrap_or("")
                    ))))
                })
            }),
        );
        Ok(())
    }
}
#[tokio::test]
async fn hook_rules_are_fixed_and_order_groups_preserve_load_order() {
    for rule in [
        Rule::Transform,
        Rule::Observe,
        Rule::Collect,
        Rule::FirstAnswer,
        Rule::Gate,
    ] {
        let h = Harness::new();
        let owner = Arc::new(Owner {
            point: std::sync::Mutex::new(None),
            rule,
        });
        h.load(owner.clone()).await.unwrap();
        for (name, order, suffix) in [
            ("normal", Order::Normal, "N"),
            ("last1", Order::Last, "L"),
            ("first1", Order::First, "F"),
            ("first2", Order::First, "G"),
        ] {
            h.load(Arc::new(Listener {
                name,
                order,
                suffix,
                refuse: false,
            }))
            .await
            .unwrap();
        }
        let token = owner.point.lock().unwrap().clone().unwrap();
        let result = h
            .invoke(&token, &Scope::default(), json!(""))
            .await
            .unwrap();
        match rule {
            Rule::Transform | Rule::Gate => assert_eq!(result.value, "FGNL"),
            Rule::Observe => assert_eq!(result.value, ""),
            Rule::Collect => assert_eq!(result.value, json!(["F", "G", "N", "L"])),
            Rule::FirstAnswer => assert_eq!(result.value, "F"),
        }
    }
}
#[tokio::test]
async fn gate_handler_errors_fail_closed() {
    let h = Harness::new();
    let owner = Arc::new(Owner {
        point: std::sync::Mutex::new(None),
        rule: Rule::Gate,
    });
    h.load(owner.clone()).await.unwrap();
    h.load(Arc::new(Listener {
        name: "bad",
        order: Order::Normal,
        suffix: "",
        refuse: true,
    }))
    .await
    .unwrap();
    let token = owner.point.lock().unwrap().clone().unwrap();
    assert!(
        h.invoke(&token, &Scope::default(), json!({}))
            .await
            .unwrap()
            .refused
            .is_some()
    );
}
#[tokio::test]
async fn hook_tokens_cannot_invoke_another_owners_point_or_survive_replacement() {
    let h = Harness::new();
    let owner = Arc::new(Owner {
        point: std::sync::Mutex::new(None),
        rule: Rule::Observe,
    });
    h.load(owner.clone()).await.unwrap();
    let token = owner.point.lock().unwrap().clone().unwrap();
    let mut wrong = token.clone();
    wrong.name = "input".into();
    assert!(
        h.invoke(&wrong, &Scope::default(), json!({}))
            .await
            .is_err()
    );
    struct Replacement;
    impl Plugin for Replacement {
        fn name(&self) -> &str {
            "replacement-owner"
        }
        fn replaces(&self) -> Option<&str> {
            Some("owner")
        }
        fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
            r.define("custom", Rule::Observe)?;
            Ok(())
        }
    }
    h.load(Arc::new(Replacement)).await.unwrap();
    assert!(
        h.invoke(&token, &Scope::default(), json!({}))
            .await
            .is_err()
    );
}
#[tokio::test]
async fn a_failed_plugin_install_leaves_no_partial_capability() {
    struct Failed;
    impl Plugin for Failed {
        fn name(&self) -> &str {
            "failed"
        }
        fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
            r.provide("temporary", Arc::new(17i32))?;
            bail!("install failed")
        }
    }
    let h = Harness::new();
    assert!(h.load(Arc::new(Failed)).await.is_err());
    assert!(capability::<i32>(h.as_ref(), "temporary").is_err());
}
struct Sample {
    name: &'static str,
    replace: Option<&'static str>,
    value: i32,
}
impl Plugin for Sample {
    fn name(&self) -> &str {
        self.name
    }
    fn replaces(&self) -> Option<&str> {
        self.replace
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide("sample", Arc::new(self.value))
    }
}
#[tokio::test]
async fn capabilities_are_plugins_and_replacement_is_explicit() {
    let h = Harness::new();
    assert!(capability::<i32>(h.as_ref(), "sample").is_err());
    h.load(Arc::new(Sample {
        name: "one",
        replace: None,
        value: 1,
    }))
    .await
    .unwrap();
    assert!(
        h.load(Arc::new(Sample {
            name: "clash",
            replace: None,
            value: 2
        }))
        .await
        .is_err()
    );
    assert_eq!(*capability::<i32>(h.as_ref(), "sample").unwrap(), 1);
    h.load(Arc::new(Sample {
        name: "two",
        replace: Some("one"),
        value: 2,
    }))
    .await
    .unwrap();
    assert_eq!(*capability::<i32>(h.as_ref(), "sample").unwrap(), 2);
}
