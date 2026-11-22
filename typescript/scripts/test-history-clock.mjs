// These are short, disposable leases on an awake test host, not a production default.
if (process.platform === "darwin") process.env.MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS ??= "20";
