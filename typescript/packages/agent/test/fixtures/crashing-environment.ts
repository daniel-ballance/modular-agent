import { LocalEnvironment } from "@modular-agent/env-local";
import type { ExecResult, Plugin } from "@modular-agent/harness";

// Kill the RPC host while it owes the Harness an exec result. A shell's parent
// is not necessarily the RPC host: on macOS it is the command supervisor.
export function crashingEnvironment({ tmp }: { tmp: string }): Plugin {
	// Only the doomed RPC child uses this directory; its test owns cleanup.
	process.env.TMPDIR = tmp;
	class CrashingEnvironment extends LocalEnvironment {
		override at() { return this; }
		override forSession() { return this; }
		override async exec(): Promise<ExecResult> {
			process.kill(process.pid, "SIGKILL");
			return new Promise(() => {});
		}
	}
	return {
		name: "env-crashing",
		replaces: "env-local",
		setup(api) { api.provide("working-environment", new CrashingEnvironment(api.project)); },
	};
}
