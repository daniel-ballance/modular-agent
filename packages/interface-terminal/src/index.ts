import { createInterface, type Interface as Readline } from "node:readline";
import type { AgentEvent, InputRequest, InterfaceCapability, Plugin, PluginApi } from "@modular-agent/harness";
import { textOf } from "@modular-agent/harness";

export type TerminalMode = "interactive" | "print" | "json";
export interface TerminalOptions {
	mode: TerminalMode;
	/** The prompt for print and JSON modes. */
	prompt?: string;
	/** Open this session instead of starting a new one. */
	sessionId?: string;
	actorId?: string;
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/**
 * A line-based terminal Interface. Interactive mode reads lines: while a turn
 * runs, a line steers it, and a line starting with ">>" waits for the turn to
 * end. Ctrl+C cancels the running turn; twice in a row quits.
 */
export class TerminalInterface implements InterfaceCapability {
	readonly id = "terminal";
	readonly actorId: string;
	private api!: PluginApi;
	private sessionId = "";
	private unfollow?: () => void;
	private requests: InputRequest[] = [];
	private rl?: Readline;
	private out: NodeJS.WritableStream;
	private lastText = "";
	private streaming = false;
	private exitCode = 0;

	constructor(private options: TerminalOptions) {
		this.actorId = options.actorId ?? "user";
		this.out = options.output ?? process.stdout;
	}

	attach(api: PluginApi): void {
		this.api = api;
	}

	private write(s: string): void {
		this.out.write(s);
	}

	private line(s = ""): void {
		if (this.streaming) {
			this.write("\n");
			this.streaming = false;
		}
		this.write(s + "\n");
	}

	onInputRequest(request: InputRequest): void {
		if (this.options.mode !== "interactive") {
			// Nobody is there to answer in print and JSON modes.
			queueMicrotask(() => this.api.answer(request.sessionId, { requestId: request.id, actorId: this.actorId, declined: true, reason: "nobody to answer in print mode" }));
			return;
		}
		this.requests.push(request);
		if (request.kind === "approval" || request.options) this.line();
		const choices = request.kind === "approval" ? ["allow", "refuse"] : request.options;
		this.line(yellow(`? ${request.question}`) + (request.details ? `\n${dim(request.details)}` : ""));
		if (choices?.length) this.line(choices.map((c, i) => `  ${i + 1}. ${c}`).join("\n"));
		this.line(dim(request.kind === "secret" ? "Type the secret and press Enter." : "Type your answer and press Enter. An empty line declines."));
	}

	onInputRequestClosed(requestId: string): void {
		this.requests = this.requests.filter((r) => r.id !== requestId);
	}

	/** A question takes the next line only while a turn runs. One left open past its turn is answered with /answer. */
	private blocking(): boolean {
		return this.requests.length > 0 && this.api.session(this.sessionId).busy;
	}

	private follow(): void {
		this.unfollow?.();
		this.unfollow = this.api.follow(this.sessionId, { recipient: `terminal:${this.actorId}` }, (event) => this.show(event));
	}

	private show(event: AgentEvent): void {
		if (this.options.mode === "json") {
			this.write(JSON.stringify(event) + "\n");
			return;
		}
		if (this.options.mode === "print") {
			if (event.type === "turn.ended") this.lastText = event.data?.result?.text ?? this.lastText;
			if (event.type === "turn.ended" && event.data?.outcome?.kind === "failed") this.exitCode = 1;
			return;
		}
		switch (event.type) {
			case "model.output":
				if (event.data?.type === "text") {
					this.write(event.data.delta);
					this.streaming = true;
				} else if (event.data?.type === "reasoning") {
					this.write(dim(event.data.delta));
					this.streaming = true;
				}
				break;
			case "tool.started": {
				const call = event.data.call;
				const input = JSON.stringify(call.input);
				this.line(cyan(`→ ${call.name} ${input.length > 160 ? input.slice(0, 160) + "…" : input}`));
				break;
			}
			case "tool.result":
				if (event.data.status !== "completed") this.line(dim(`  ${event.data.status}`));
				break;
			case "model.retry":
				this.line(yellow(`retrying (${event.data.attempt}): ${event.data.error?.message ?? ""}`));
				break;
			case "context.compacted":
				this.line(dim(`[compacted ${event.data.summarized} entries]`));
				break;
			case "job.ended":
				this.line(dim(`[job ${event.jobId?.slice(0, 8)} ${event.data.state}]`));
				break;
			case "turn.ended": {
				const outcome = event.data.outcome;
				if (outcome.kind === "failed") this.line(red(`Turn failed: ${outcome.error}`));
				else if (outcome.kind === "limit") this.line(yellow(`Stopped at the ${outcome.limit} limit`));
				else if (outcome.kind === "cancelled") this.line(yellow("Cancelled"));
				else this.line();
				const open = event.data.result?.openToolCalls?.length ?? 0;
				if (open) this.line(yellow(`Waiting for an answer before ${open} tool call${open > 1 ? "s" : ""} can run. Answer with /answer <reply> (for an approval: allow or refuse) whenever you're ready; the agent carries on then.`));
				const u = event.data.usage;
				if (u) this.line(dim(`[${u.input} in, ${u.output} out${u.cost ? `, $${u.cost.toFixed(4)}` : ""}]`));
				this.prompt();
				break;
			}
			case "plugin.problem":
				this.line(red(`[${event.data.plugin}] ${event.data.where}: ${event.data.error}`));
				break;
		}
	}

	private prompt(): void {
		this.rl?.setPrompt(this.api.session(this.sessionId).busy ? "" : "> ");
		this.rl?.prompt();
	}

	private async openOrStart(): Promise<void> {
		this.sessionId = this.options.sessionId
			? await this.api.openSession(this.options.sessionId)
			: await this.api.startSession();
		this.follow();
	}

	/** Run until the user quits, or the prompt is answered. Returns the exit code. */
	async run(): Promise<number> {
		await this.openOrStart();
		if (this.options.mode !== "interactive") return this.runOnce();
		return this.runInteractive();
	}

	private async runOnce(): Promise<number> {
		const prompt = this.options.prompt ?? "";
		if (!prompt) {
			this.line("No prompt given.");
			return 2;
		}
		const receipt = await this.api.input(this.sessionId, { content: prompt, actorId: this.actorId });
		if (receipt.handled) {
			if (receipt.output) this.line(receipt.output);
			return 0;
		}
		// One-shot modes wait for background jobs too: a job's report may start another turn.
		for (;;) {
			await this.api.waitForIdle(this.sessionId);
			if (!this.api.jobs(this.sessionId).length) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		await this.api.waitForIdle(this.sessionId);
		if (this.options.mode === "print") this.line(this.lastText);
		return this.exitCode;
	}

	private async runInteractive(): Promise<number> {
		const rl = createInterface({ input: this.options.input ?? process.stdin, output: this.out, terminal: true });
		this.rl = rl;
		this.line(dim(`Session ${this.sessionId}. Model: ${this.api.session(this.sessionId).settings.model ?? "(none, use /model)"}. /help lists commands.`));
		if (this.requests.length && !this.api.session(this.sessionId).busy) this.line(yellow("A question is still open. Answer it with /answer <reply>."));
		let lastInterrupt = 0;
		rl.on("SIGINT", async () => {
			if (this.api.session(this.sessionId).busy) {
				const handedBack = await this.api.cancel(this.sessionId);
				if (handedBack.length) {
					const textBack = handedBack.map((q) => textOf(q.content)).join("\n");
					this.line(dim("Queued input handed back:"));
					rl.write(textBack);
				}
				return;
			}
			if (Date.now() - lastInterrupt < 1500) rl.close();
			else this.line(dim("Press Ctrl+C again to quit."));
			lastInterrupt = Date.now();
		});
		this.prompt();
		for await (const raw of rl) {
			const line = raw.trim();
			if (this.blocking()) {
				this.answer(this.requests[0], line);
				continue;
			}
			if (!line) {
				this.prompt();
				continue;
			}
			if (line === "/quit" || line === "/exit") break;
			if (await this.localCommand(line)) {
				this.prompt();
				continue;
			}
			const followUp = line.startsWith(">>");
			const content = followUp ? line.slice(2).trim() : line;
			try {
				const busy = this.api.session(this.sessionId).busy;
				const receipt = await this.api.input(this.sessionId, { content, actorId: this.actorId, when: busy ? (followUp ? "after" : "steer") : "now" });
				if (receipt.handled) {
					if (receipt.output) this.line(receipt.output);
					this.prompt();
				} else if (receipt.taken !== "now") this.line(dim(receipt.taken === "inTurn" ? "[steering]" : "[queued]"));
			} catch (error) {
				this.line(red(error instanceof Error ? error.message : String(error)));
				this.prompt();
			}
		}
		rl.close();
		this.unfollow?.();
		return 0;
	}

	private answer(request: InputRequest, line: string): void {
		let value: string | undefined = line;
		const choices = request.kind === "approval" ? ["allow", "refuse"] : request.options;
		if (choices && /^\d+$/.test(line)) value = choices[Number(line) - 1];
		const declined = !line || (request.kind === "approval" && value !== "allow");
		const result = this.api.answer(this.sessionId, { requestId: request.id, actorId: this.actorId, value: declined ? undefined : value, declined });
		// A secret must not stay in the line history, where the up arrow would bring it back.
		if (request.kind === "secret") {
			const history = (this.rl as unknown as { history?: string[] } | undefined)?.history;
			if (history?.[0] === line) history.shift();
		}
		if (!result.accepted) this.line(red(result.reason ?? "Not accepted"));
	}

	/** Commands this Interface handles itself, because they change which session it shows. */
	private async localCommand(line: string): Promise<boolean> {
		const [name, ...rest] = line.split(/\s+/);
		const arg = rest.join(" ");
		switch (name) {
			case "/help": {
				const commands = [
					["/new", "start a new session"],
					["/sessions", "list sessions in this project"],
					["/resume <id>", "open another session"],
					["/fork [n]", "fork this session at its nth-last input (default 1)"],
					["/back [n]", "move back to before the nth-last input (default 1)"],
					["/answer <reply>", "answer a question left open past its turn"],
					["/jobs", "list running jobs"],
					["/quit", "quit"],
					...this.api.commands().map((c) => [`/${c.name}`, c.description]),
				];
				this.line(commands.map(([c, d]) => `  ${c.padEnd(16)} ${dim(d)}`).join("\n"));
				return true;
			}
			case "/new":
				await this.api.closeSession(this.sessionId);
				this.options.sessionId = undefined;
				await this.openOrStart();
				this.line(dim(`New session ${this.sessionId}`));
				return true;
			case "/sessions": {
				const list = await this.api.listSessions();
				this.line(list.slice(0, 20).map((s) => `  ${s.id}  ${dim(new Date(s.created).toLocaleString())}`).join("\n") || "No sessions.");
				return true;
			}
			case "/resume": {
				if (!arg) return this.line("Usage: /resume <session id>"), true;
				await this.api.closeSession(this.sessionId);
				this.options.sessionId = arg;
				await this.openOrStart();
				this.line(dim(`Opened ${this.sessionId}`));
				return true;
			}
			case "/fork":
			case "/back": {
				const n = Number(arg || 1);
				const inputs = this.api.history(this.sessionId).filter((e) => e.kind === "input");
				const target = inputs[inputs.length - n];
				if (!target) return this.line("Nothing to go back to."), true;
				if (name === "/back") {
					await this.api.moveTo(this.sessionId, target.parentId ?? target.id, { actorId: this.actorId });
					this.line(dim(`Moved back. The next input continues from before: ${textOf(target.message?.content ?? []).slice(0, 80)}`));
				} else {
					const old = this.sessionId;
					this.sessionId = await this.api.forkSession(old, target.parentId ?? target.id);
					this.follow();
					this.line(dim(`Forked ${old} into ${this.sessionId}`));
				}
				return true;
			}
			case "/answer": {
				const request = this.requests[0];
				if (!request) return this.line("No question is open."), true;
				this.answer(request, arg);
				return true;
			}
			case "/jobs": {
				const jobs = this.api.jobs(this.sessionId);
				this.line(jobs.map((j) => `  ${j.id.slice(0, 8)} ${j.kind} ${j.state}`).join("\n") || "No jobs.");
				return true;
			}
		}
		return false;
	}
}

/** Provides the Interface capability. The host calls run() once plugins are loaded. */
export function terminalInterface(options: TerminalOptions): Plugin & { terminal: TerminalInterface } {
	const terminal = new TerminalInterface(options);
	return {
		name: "interface-terminal",
		terminal,
		setup(api) {
			terminal.attach(api);
			api.provide("interface", terminal);
		},
	};
}
