// Managed ACP test listeners: one primary service, plus isolated listeners for
// fixtures that change service-side startup configuration.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { isLoopback } from "../tools/websocket.mjs";

export function trackProcess(child, verbose, agents) {
	let stderr = "", spawnError;
	child.stderr?.setEncoding("utf8").on("data", (chunk) => {
		stderr = (stderr + chunk).slice(-8192);
		if (verbose) process.stderr.write(chunk);
	});
	const exited = new Promise((resolve) => {
		child.once("error", (error) => {
			spawnError = error.message;
			resolve({ code: null, signal: null });
		});
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	const closed = new Promise((resolve) => child.once("close", resolve));
	const status = () => ({ exitCode: child.exitCode, signal: child.signalCode, spawnError, stderr });
	const tracked = { child, exited, closed, status };
	agents.push(tracked);
	return tracked;
}

export async function finishAgents(agents, reportStderr) {
	for (const { child } of agents) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	if (!reportStderr) return;
	// Wait for buffered diagnostics even after exit. Descendants can hold a pipe open.
	await Promise.race([Promise.all(agents.map(({ closed }) => closed)), delay(2000, undefined, { ref: false })]);
	for (const { child, status } of agents) {
		const { stderr } = status();
		if (stderr) {
			await new Promise((resolve) => process.stderr.write(
				`Agent stderr (PID ${child.pid}, last 8192 characters):\n${stderr.trimEnd()}\n`, resolve,
			));
		}
	}
}

export function manageServices(config, command, cwd, envFor, verbose, agents) {
	let primary;
	const children = new Set();
	const launch = (url, extraEnv) => {
		const child = spawn("bash", ["-c", command], {
			cwd, env: { ...envFor(extraEnv), MODULAR_AGENT_CONFORMANCE_URL: url.href, MODULAR_AGENT_CONFORMANCE_TOKEN_FILE: config.tokenFile },
			detached: true, stdio: ["ignore", verbose ? "inherit" : "ignore", "pipe"],
		});
		const service = { ...trackProcess(child, verbose, agents), url };
		children.add(service);
		return service;
	};
	// macOS kill(2) returns EPERM for a group when a member cannot be signalled, such as a zombie;
	// the live members are still signalled. Linux returns success.
	const signalGroup = (service, signal) => {
		if (!service.child.pid) return;
		try { process.kill(-service.child.pid, signal); } catch (e) { if (e.code !== "ESRCH" && !(process.platform === "darwin" && e.code === "EPERM")) throw e; }
	};
	const stop = async (service, signal = "SIGTERM") => {
		if (service === primary) primary = undefined;
		if (!children.delete(service)) return;
		signalGroup(service, signal);
		let timer;
		try { await Promise.race([service.exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]); }
		finally { clearTimeout(timer); signalGroup(service, "SIGKILL"); }
	};
	process.once("exit", () => { for (const service of children) signalGroup(service, "SIGKILL"); });
	return {
		primary: () => primary ??= launch(config.url, {}),
		async variant(extraEnv) {
			if (!isLoopback(config.url.hostname)) throw new Error("service variants require a loopback --connect URL");
			const host = config.url.hostname.replace(/^\[|\]$/g, "");
			const url = new URL(config.url);
			url.port = await new Promise((resolve, reject) => {
				const reserve = createServer().once("error", reject);
				reserve.listen(0, host, () => {
					const { port } = reserve.address();
					reserve.close((error) => error ? reject(error) : resolve(port));
				});
			});
			return launch(url, extraEnv);
		},
		stop,
		stopAll: () => Promise.all([...children].map((service) => stop(service))),
	};
}
