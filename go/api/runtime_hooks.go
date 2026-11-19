package api

// RuntimeHooks returns the fixed standard hook rules shared by all Runtimes.
// Owners dispatch them through their identity-bound API; handlers run in the Harness.
func RuntimeHooks() map[string]Rule {
	return map[string]Rule{
		"runtime.turn.start": Observe, "runtime.step.before": Transform,
		"runtime.step.after": Transform, "runtime.tool.before": Gate,
		"runtime.tool.after": Transform, "runtime.request.failed": FirstAnswer,
		"runtime.result": Transform, "runtime.turn.end": Observe,
	}
}
