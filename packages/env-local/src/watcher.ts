// Runs as its own process. Waits for the agent to die, then kills what it left running.
import { existsSync } from "node:fs";
import { cleanUp } from "./processes.js";

const agentPid = Number(process.argv[2]);
const file = process.argv[3];

const timer = setInterval(() => {
	if (!existsSync(file)) {
		// The agent stopped cleanly and cleaned up itself.
		clearInterval(timer);
		return;
	}
	try {
		process.kill(agentPid, 0);
	} catch {
		clearInterval(timer);
		cleanUp(file);
	}
}, 250);
