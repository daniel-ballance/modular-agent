// The watcher is the group leader. It keeps the group ID reserved after bash exits.
import { spawn } from "node:child_process";
import { closeSync, writeSync } from "node:fs";

let stopping = false;
function stop() {
	if (stopping) return;
	stopping = true;
	process.kill(-process.pid, "SIGTERM");
	setTimeout(() => process.kill(-process.pid, "SIGKILL"), 250);
}
function result(frame: { code: number | null } | { error: string }) {
	try { writeSync(3, JSON.stringify(frame) + "\n"); }
	catch { stop(); }
	finally { closeSync(3); }
}

// Node signal handlers are not inherited across exec. Bash receives TERM normally.
process.on("SIGTERM", () => {});
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdin.resume();
const child = spawn("/bin/bash", ["-c", process.argv[2]], { stdio: ["ignore", 1, 2] });
closeSync(1);
closeSync(2);
child.on("error", error => result({ error: error.message }));
child.on("exit", code => result({ code }));
