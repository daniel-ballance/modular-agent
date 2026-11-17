#!/usr/bin/env node
import { terminalInterface, type TerminalMode } from "@modular-agent/interface-terminal";
import { approval, type ApprovalPolicy } from "@modular-agent/approval";
import { acpInterface } from "@modular-agent/interface-acp";
import { tuiInterface } from "@modular-agent/interface-tui";
import { subagents } from "@modular-agent/subagents";
import { mcpTools } from "@modular-agent/tools-mcp";
import { httpInterface } from "@modular-agent/interface-http";
import { randomUUID } from "node:crypto";
import { durableRuntime } from "@modular-agent/runtime-durable";
import { questionTool } from "@modular-agent/tools-question";
import { createAgent } from "./index.js";

function parse(argv: string[]) {
	const out: { mode: TerminalMode; prompt?: string; model?: string; session?: string; piAuth: boolean; ephemeral: boolean; durable: boolean; approval?: ApprovalPolicy; approvalWait?: number; questionWait?: number; acp: boolean; plain: boolean; serve?: number; help: boolean } = {
		mode: "interactive", piAuth: false, ephemeral: false, durable: false, acp: false, plain: false, help: false,
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
		else if (a === "--acp") out.acp = true;
		else if (a === "--plain") out.plain = true;
		else if (a === "--serve") out.serve = Number(argv[++i] ?? 0);
		else if (a === "--approval") out.approval = argv[++i] as ApprovalPolicy;
		else if (a === "--approval-wait") out.approvalWait = Number(argv[++i]) * 1000;
		else if (a === "--question-wait") out.questionWait = Number(argv[++i]) * 1000;
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
  ma --acp [options]           serve ACP (Agent Client Protocol) on stdin and stdout
  ma --plain [options]         line-based interactive mode, instead of the full-screen TUI
  ma --serve <port> [options]  serve the agent over HTTP (token from MA_HTTP_TOKEN, or printed)

Options:
  -m, --model provider/id   model to use (or set "plugins.model-selection.default" in settings)
  -s, --session id          open an earlier session
  --pi-auth                 use Pi's credentials (~/.pi/agent/auth.json)
  --ephemeral               keep no history on disk
  --durable                 durable Runtime and subagents: turns and subagents carry on after a crash
  --approval <policy>       ask before tool calls: ask (unless read-only), all, never or off
  --approval-wait <seconds> after this long, end the turn and leave the question open
  --question-wait <seconds> the same for questions the model asks with ask_user
`;

async function main() {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (args.mode === "interactive" && args.prompt) args.mode = "print";
	const common = [questionTool({ waitMs: args.questionWait }), subagents({ durable: args.durable }), mcpTools(), ...(args.durable ? [durableRuntime()] : []), ...(args.approval ? [approval({ policy: args.approval, waitMs: args.approvalWait })] : [])];
	if (args.acp) {
		// stdout carries the protocol, so nothing else may write to it.
		console.log = (...m: unknown[]) => process.stderr.write(m.join(" ") + "\n");
		const acp = acpInterface();
		const harness = await createAgent({ model: args.model, usePiAuth: args.piAuth, ephemeral: args.ephemeral, plugins: [...common, acp] });
		try {
			await acp.acp.serveStdio();
			return 0;
		} finally {
			await harness.stop();
		}
	}
	if (args.serve !== undefined) {
		const token = process.env.MA_HTTP_TOKEN ?? randomUUID();
		const web = httpInterface({ token, port: args.serve });
		const harness = await createAgent({ model: args.model, usePiAuth: args.piAuth, ephemeral: args.ephemeral, plugins: [...common, web] });
		process.stdout.write(JSON.stringify({ url: web.http!.url, ...(process.env.MA_HTTP_TOKEN ? {} : { token }) }) + "\n");
		await new Promise<void>((resolve) => {
			process.once("SIGINT", resolve);
			process.once("SIGTERM", resolve);
		});
		await harness.stop();
		return 0;
	}
	if (args.mode === "interactive" && !args.plain && process.stdout.isTTY && process.stdin.isTTY) {
		const tui = tuiInterface({ sessionId: args.session });
		const harness = await createAgent({ model: args.model, usePiAuth: args.piAuth, ephemeral: args.ephemeral, plugins: [...common, tui] });
		try {
			return await tui.tui.run();
		} finally {
			await harness.stop();
		}
	}
	const ui = terminalInterface({ mode: args.mode, prompt: args.prompt, sessionId: args.session });
	const harness = await createAgent({ model: args.model, usePiAuth: args.piAuth, ephemeral: args.ephemeral, plugins: [...common, ui] });
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
