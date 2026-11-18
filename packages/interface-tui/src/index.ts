import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	type EditorTheme,
	Loader,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	SelectList,
	type SelectListTheme,
	Text,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { AgentEvent, HistoryEntry, InputRequest, InterfaceCapability, Plugin, PluginApi } from "@modular-agent/harness";
import { isToolCall, parseModel, textOf } from "@modular-agent/harness";

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = esc("2");
const bold = esc("1");
const italic = esc("3");
const cyan = esc("36");
const yellow = esc("33");
const red = esc("31");
const green = esc("32");
const magenta = esc("35");
const userBg = esc("48;5;236");

const selectTheme: SelectListTheme = { selectedPrefix: cyan, selectedText: cyan, description: dim, scrollInfo: dim, noMatch: yellow };
const editorTheme: EditorTheme = { borderColor: dim, selectList: selectTheme };
const markdownTheme: MarkdownTheme = {
	heading: (s) => bold(cyan(s)), link: cyan, linkUrl: dim, code: yellow, codeBlock: (s) => s, codeBlockBorder: dim,
	quote: italic, quoteBorder: dim, hr: dim, listBullet: cyan, bold, italic, strikethrough: (s) => `\x1b[9m${s}\x1b[0m`, underline: (s) => `\x1b[4m${s}\x1b[0m`,
};

const LOCAL_COMMANDS: [string, string][] = [
	["new", "start a new session"],
	["sessions", "list sessions in this project"],
	["resume", "open another session: /resume <id>"],
	["fork", "fork at the nth-last input: /fork [n]"],
	["back", "move back to before the nth-last input: /back [n]"],
	["answer", "answer a question left open past its turn: /answer <reply>"],
	["jobs", "list running jobs"],
	["help", "list commands and keys"],
	["quit", "quit"],
];

interface ToolView { header: Text; output: Text; buffer: string; name: string; input: string }

/**
 * A full-screen terminal Interface built on Pi's TUI library. Markdown streams
 * as the model writes; each tool call is a card with its live output. Enter
 * sends, or steers a running turn; ">>" waits for the turn to end. Esc cancels
 * the running turn and hands queued input back to the editor. Ctrl+C twice quits.
 */
export class TuiInterface implements InterfaceCapability {
	readonly id = "tui";
	readonly actorId: string;
	private api!: PluginApi;
	private sessionId = "";
	private tui!: TUI;
	private transcript = new Container();
	private editor!: Editor;
	private loader?: Loader;
	private markdown?: Markdown;
	private markdownText = "";
	private thinking?: Text;
	private thinkingText = "";
	private tools = new Map<string, ToolView>();
	private questions: InputRequest[] = [];
	private picker?: { list: SelectList; label: Text; request: InputRequest };
	private unfollow?: () => void;
	private quit!: (code: number) => void;
	private lastCtrlC = 0;

	constructor(private options: { sessionId?: string; actorId?: string } = {}) {
		this.actorId = options.actorId ?? "user";
	}

	attach(api: PluginApi): void {
		this.api = api;
	}

	private add(component: Text | Markdown | Container | SelectList): void {
		this.transcript.addChild(component);
		this.tui?.requestRender();
	}

	private note(text: string): void {
		this.add(new Text(text, 1, 0));
	}

	// ---------- questions ----------

	onInputRequest(request: InputRequest): void {
		this.questions.push(request);
		const choices = request.kind === "approval" ? ["allow", "refuse"] : request.options;
		if (choices?.length) {
			if (!this.picker) this.showPicker(request, choices);
			return;
		}
		this.note(yellow(`? ${request.question}`) + dim(this.isBusy() ? "  (type your answer and press Enter)" : "  (answer with /answer <reply>)"));
	}

	onInputRequestClosed(requestId: string): void {
		this.questions = this.questions.filter((r) => r.id !== requestId);
		if (this.picker?.request.id === requestId) this.closePicker();
	}

	private showPicker(request: InputRequest, choices: string[]): void {
		const label = new Text(yellow(`? ${request.question}`) + (request.details ? `\n${dim(request.details)}` : ""), 1, 0);
		const list = new SelectList(choices.map((c) => ({ value: c, label: c })), 8, selectTheme);
		list.onSelect = (item) => this.answer(request, item.value);
		list.onCancel = () => this.answer(request, "");
		this.picker = { list, label, request };
		this.tui.removeChild(this.editor);
		this.tui.addChild(label);
		this.tui.addChild(list);
		this.tui.setFocus(list);
		this.tui.requestRender();
	}

	private closePicker(): void {
		if (!this.picker) return;
		this.tui.removeChild(this.picker.label);
		this.tui.removeChild(this.picker.list);
		this.picker = undefined;
		this.tui.addChild(this.editor);
		this.tui.setFocus(this.editor);
		const next = this.questions.find((q) => q.kind === "approval" || q.options?.length);
		if (next) this.showPicker(next, next.kind === "approval" ? ["allow", "refuse"] : next.options!);
		this.tui.requestRender();
	}

	private answer(request: InputRequest, value: string): void {
		const declined = !value || (request.kind === "approval" && value !== "allow");
		const result = this.api.answer(request.sessionId, { requestId: request.id, actorId: this.actorId, value: declined ? undefined : value, declined });
		this.note(result.accepted ? dim(`  answered: ${declined ? "declined" : request.kind === "secret" ? "(secret)" : value}`) : red(result.reason ?? "Not accepted"));
		this.onInputRequestClosed(request.id);
	}

	// ---------- following the session ----------

	private isBusy(): boolean {
		return this.api.session(this.sessionId).busy;
	}

	private follow(): void {
		this.unfollow?.();
		this.unfollow = this.api.follow(this.sessionId, { recipient: this.actorId }, (e) => this.show(e));
	}

	private endStream(): void {
		this.markdown = undefined;
		this.markdownText = "";
		this.thinking = undefined;
		this.thinkingText = "";
	}

	private show(event: AgentEvent): void {
		switch (event.type) {
			case "turn.started":
				this.endStream();
				this.loader = new Loader(this.tui, cyan, dim, "Working… (Esc to cancel)");
				this.tui.addChild(this.loader);
				this.tui.removeChild(this.editor);
				this.tui.addChild(this.editor);
				break;
			case "step.started":
				this.endStream();
				break;
			case "model.output":
				if (event.data?.type === "text") {
					if (!this.markdown) {
						this.markdown = new Markdown("", 1, 0, markdownTheme);
						this.add(this.markdown);
					}
					this.markdownText += event.data.delta;
					this.markdown.setText(this.markdownText);
				} else if (event.data?.type === "reasoning") {
					if (!this.thinking) {
						this.thinking = new Text("", 1, 0);
						this.add(this.thinking);
					}
					this.thinkingText += event.data.delta;
					this.thinking.setText(dim(italic(this.thinkingText.trim())));
				}
				break;
			case "entry.added":
				this.entry(event.data as HistoryEntry);
				break;
			case "tool.started": {
				const view = this.tools.get(event.toolCallId!);
				if (view) view.header.setText(cyan(`⏵ ${view.name} `) + dim(view.input));
				this.endStream();
				break;
			}
			case "tool.progress": {
				const view = this.tools.get(event.toolCallId!);
				if (!view) break;
				view.buffer = (view.buffer + textOf(event.data.content)).slice(-4000);
				view.output.setText(dim(view.buffer.trimEnd().split("\n").slice(-6).join("\n")));
				break;
			}
			case "tool.result": {
				const view = this.tools.get(event.toolCallId!);
				const ok = event.data.status === "completed";
				if (view) view.header.setText((ok ? green("✓ ") : red(`✗ ${event.data.status} `)) + cyan(view.name + " ") + dim(view.input));
				break;
			}
			case "tool.open": {
				const view = this.tools.get(event.toolCallId!);
				if (view) view.header.setText(yellow("… ") + cyan(view.name + " ") + dim(`${view.input}  (waiting for an answer)`));
				break;
			}
			case "turn.ended": {
				if (this.loader) {
					this.loader.stop();
					this.tui.removeChild(this.loader);
					this.loader = undefined;
				}
				this.endStream();
				const outcome = event.data.outcome;
				if (outcome.kind === "failed") this.note(red(`Turn failed: ${outcome.error}`));
				else if (outcome.kind === "limit") this.note(yellow(`Stopped at the ${outcome.limit} limit`));
				else if (outcome.kind === "cancelled") this.note(yellow("Cancelled"));
				const open = event.data.result?.openToolCalls?.length ?? 0;
				if (open) this.note(yellow(`Waiting for an answer before ${open} tool call${open > 1 ? "s" : ""} can run. Answer when ready; the agent carries on then.`));
				const u = event.data.usage;
				if (u && (u.input || u.output)) this.note(dim(`${u.input} in · ${u.output} out${u.cost ? ` · $${u.cost.toFixed(4)}` : ""}`));
				break;
			}
			case "context.compacted":
				this.note(dim(`compacted ${event.data.summarized} entries`));
				break;
			case "job.started":
				this.note(magenta(`job ${event.data.job.kind} started`));
				break;
			case "job.ended":
				this.note(magenta(`job ${event.jobId?.slice(0, 8)} ${event.data.state}`));
				break;
			case "plugin.problem":
				this.note(red(`[${event.data.plugin}] ${event.data.where}: ${event.data.error}`));
				break;
		}
		this.tui.requestRender();
	}

	private entry(entry: HistoryEntry): void {
		if (entry.kind === "response" && entry.message?.role === "assistant") {
			for (const part of entry.message.content.filter(isToolCall)) {
				const input = JSON.stringify(part.arguments ?? {});
				const view: ToolView = { header: new Text(dim("○ ") + cyan(part.name + " ") + dim(input.length > 120 ? input.slice(0, 120) + "…" : input), 1, 0), output: new Text("", 3, 0), buffer: "", name: part.name, input: input.length > 120 ? input.slice(0, 120) + "…" : input };
				this.tools.set(part.id, view);
				this.add(view.header);
				this.add(view.output);
			}
			this.endStream();
		} else if (entry.kind === "input" && entry.actorId !== this.actorId && entry.message) {
			this.add(new Text(userBg(` ${entry.jobId ? "job" : entry.actorId}: ${textOf(entry.message.content)} `), 1, 0));
		}
	}

	// ---------- input ----------

	private async submit(raw: string): Promise<void> {
		const line = raw.trim();
		if (!line) return;
		const pending = this.questions.find((q) => !(q.kind === "approval" || q.options?.length));
		if (pending && this.isBusy()) {
			// A secret stays out of the editor's history.
			if (pending.kind !== "secret") this.editor.addToHistory(line);
			return this.answer(pending, line);
		}
		this.editor.addToHistory(line);
		if (line === "/quit" || line === "/exit") return this.quit(0);
		if (await this.local(line)) return;
		const followUp = line.startsWith(">>");
		const content = followUp ? line.slice(2).trim() : line;
		const busy = this.isBusy();
		this.add(new Text(userBg(` ${content} `), 1, 1));
		try {
			const receipt = await this.api.input(this.sessionId, { content, actorId: this.actorId, when: busy ? (followUp ? "after" : "steer") : "now" });
			if (receipt.handled && receipt.output) this.add(new Markdown(receipt.output, 1, 0, markdownTheme));
			else if (receipt.taken !== "now") this.note(dim(receipt.taken === "inTurn" ? "steering the running turn" : "queued for after this turn"));
		} catch (error) {
			this.note(red(error instanceof Error ? error.message : String(error)));
		}
	}

	private async local(line: string): Promise<boolean> {
		const [name, ...rest] = line.split(/\s+/);
		const arg = rest.join(" ");
		switch (name) {
			case "/help":
				this.note([...LOCAL_COMMANDS.map(([n, d]) => [`/${n}`, d]), ...this.api.commands().map((c) => [`/${c.name}`, c.description])].map(([c, d]) => `${cyan(c.padEnd(14))} ${dim(d)}`).join("\n") + `\n\n${dim("Enter sends (or steers a running turn) · >> queues after the turn · Esc cancels · Alt+Enter new line · Ctrl+C twice quits")}`);
				return true;
			case "/new":
				await this.api.closeSession(this.sessionId);
				this.sessionId = await this.api.startSession();
				this.follow();
				this.note(dim(`new session ${this.sessionId}`));
				return true;
			case "/sessions": {
				const list = await this.api.listSessions();
				this.note(list.slice(0, 20).map((s) => `${s.id}  ${dim(new Date(s.created).toLocaleString())}`).join("\n") || "No sessions.");
				return true;
			}
			case "/resume":
				if (!arg) return this.note("Usage: /resume <session id>"), true;
				await this.api.closeSession(this.sessionId);
				this.sessionId = await this.api.openSession(arg);
				this.follow();
				this.note(dim(`opened ${this.sessionId}`));
				return true;
			case "/fork":
			case "/back": {
				const inputs = this.api.history(this.sessionId).filter((e) => e.kind === "input");
				const target = inputs[inputs.length - Number(arg || 1)];
				if (!target) return this.note("Nothing to go back to."), true;
				if (name === "/back") {
					await this.api.moveTo(this.sessionId, target.parentId ?? target.id, { actorId: this.actorId });
					this.note(dim(`moved back to before: ${textOf(target.message?.content ?? []).slice(0, 80)}`));
				} else {
					this.sessionId = await this.api.forkSession(this.sessionId, target.parentId ?? target.id);
					this.follow();
					this.note(dim(`forked into ${this.sessionId}`));
				}
				return true;
			}
			case "/answer": {
				const request = this.questions[0];
				if (!request) return this.note("No question is open."), true;
				this.answer(request, arg);
				return true;
			}
			case "/jobs": {
				const jobs = this.api.jobs(this.sessionId);
				this.note(jobs.map((j) => `${j.id.slice(0, 8)} ${j.kind} ${j.state}`).join("\n") || "No jobs.");
				return true;
			}
		}
		return false;
	}

	async run(): Promise<number> {
		this.sessionId = this.options.sessionId ? await this.api.openSession(this.options.sessionId, { id: this.actorId, kind: "user", authority: ["watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate"] }) : await this.api.startSession();
		this.tui = new TuiMainScreen(new ProcessTerminal());
		this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
		const commands = [...LOCAL_COMMANDS.map(([name, description]) => ({ name, description })), ...this.api.commands().map((c) => ({ name: c.name, description: c.description }))];
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, this.api.projectOf(this.sessionId)));
		this.editor.onSubmit = (text) => {
			this.editor.setText("");
			void this.submit(text);
		};
		this.tui.addChild(this.transcript);
		this.tui.addChild(this.editor);
		this.tui.setFocus(this.editor);
		const ref = parseModel(this.api.session(this.sessionId).settings.model);
		const model = ref ? `${ref.provider}/${ref.id}` : "(no model: use /model)";
		this.note(`${bold("modular agent")} ${dim(`· ${model} · session ${this.sessionId.slice(0, 8)} · /help`)}`);
		for (const q of this.api.openRequests(this.sessionId)) if (!this.questions.some((x) => x.id === q.id)) this.onInputRequest(q);
		this.tui.addInputListener((data) => {
			if (matchesKey(data, "escape") && this.isBusy() && !this.picker) {
				void this.api.cancel(this.sessionId).then((handedBack) => {
					if (handedBack.length) this.editor.setText(handedBack.map((q) => textOf(q.content)).join("\n"));
				});
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+c")) {
				if (this.editor.getText()) this.editor.setText("");
				else if (Date.now() - this.lastCtrlC < 1500) this.quit(0);
				else this.note(dim("Press Ctrl+C again to quit."));
				this.lastCtrlC = Date.now();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+d") && !this.editor.getText()) {
				this.quit(0);
				return { consume: true };
			}
			return undefined;
		});
		this.follow();
		const code = await new Promise<number>((resolve) => {
			this.quit = resolve;
			this.tui.start();
		});
		this.unfollow?.();
		this.loader?.stop();
		this.tui.stop();
		return code;
	}
}

export function tuiInterface(options: { sessionId?: string; actorId?: string } = {}): Plugin & { tui: TuiInterface } {
	const tui = new TuiInterface(options);
	return {
		name: "interface-tui",
		tui,
		setup(api) {
			tui.attach(api);
			api.provide("interface", tui);
		},
	};
}
