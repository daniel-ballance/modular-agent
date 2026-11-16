#!/usr/bin/env node
import { terminalInterface, type TerminalMode } from "@modular-agent/interface-terminal";
import { approval, type ApprovalPolicy } from "@modular-agent/approval";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { createAgent } from "./index.js";

function parse(argv: string[]) {
	const out: { mode: TerminalMode; prompt?: string; model?: string; session?: string; piAuth: boolean; ephemeral: boolean; durable: boolean; approval?: ApprovalPolicy; help: boolean } = {
		mode: "interactive", piAuth: false, ephemeral: false, durable: false, help: false,
	};
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-p" || a === "--print") out.mode = "print";
		else if (a === "--json") out.mode = "json";
		else if (a === "--model" || a === "-m") out.model = argv[++i];
		else if (a === "--session" || a === "-s") out.session = argv[++i];
		else if (a === "--pi-auth") out.piAuth = true;
		else if (a === "--ephemeral") out.ephemeral = true;
		else if (a === "--durable") out.durable = true;
		else if (a === "--approval") out.approval = argv[++i] as ApprovalPolicy;
		else if (a === "-h" || a === "--help") out.help = true;
		else rest.push(a);
	}
	if (rest.length) out.prompt = rest.join(" ");
	return out;
}

const HELP = `ma: a modular agent built from plugins

Usage:
  ma [options]                 interactive
  ma -p [options] "prompt"     print the answer and exit
  ma --json [options] "prompt" print every event as JSON lines

Options:
  -m, --model provider/id   model to use (or set "plugins.model-selection.default" in settings)
  -s, --session id          open an earlier session
  --pi-auth                 use Pi's credentials (~/.pi/agent/auth.json)
  --ephemeral               keep no history on disk
  --durable                 use the durable Runtime: a turn carries on after a crash
  --approval <policy>       ask before tool calls: ask (unless read-only), all, never or off
`;

async function main() {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (args.mode === "interactive" && args.prompt) args.mode = "print";
	const ui = terminalInterface({ mode: args.mode, prompt: args.prompt, sessionId: args.session });
	const harness = await createAgent({ model: args.model, usePiAuth: args.piAuth, ephemeral: args.ephemeral, plugins: [...(args.durable ? [durableRuntime()] : []), ...(args.approval ? [approval({ policy: args.approval })] : []), ui] });
	try {
		return await ui.terminal.run();
	} finally {
		await harness.stop();
	}
}

main().then(
	(code) => process.exit(code),
	(error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exit(1);
	},
);
