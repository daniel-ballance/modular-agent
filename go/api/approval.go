package api

// ApprovalWire translates the existing Go policy names to the data binding.
func ApprovalWire(policy string) string {
	switch policy {
	case "ask-unless-read-only":
		return "ask"
	case "ask-always":
		return "all"
	}
	return policy
}

func ApprovalInternal(policy string) string {
	switch policy {
	case "ask":
		return "ask-unless-read-only"
	case "all":
		return "ask-always"
	}
	return policy
}

// ReopenedApproval does not infer an owner's intent from the local default.
func ReopenedApproval(policy string) string {
	switch policy = ApprovalInternal(policy); policy {
	case "off", "ask-unless-read-only", "ask-always", "never":
		return policy
	case "":
		return "ask-always"
	default:
		return "never"
	}
}
