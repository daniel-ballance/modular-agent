import type { Server } from "node:http";
import type { Actor, AgentEvent, InterfaceCapability, Plugin, PluginApi } from "@modular-agent/harness";
import { HttpError, serve } from "@modular-agent/services";

export interface HttpInterfaceOptions {
	/** The bearer token a client presents. It stands for one actor. */
	token: string;
	actor?: Actor;
	port?: number;
}

/**
 * The agent served over HTTP. Sessions, input, answers and cancelling are JSON
 * requests; events stream as server-sent events. Each recorded entry carries an
 * event id, so a client that reconnects with Last-Event-ID gets everything
 * recorded since, then live events. Streamed pieces sent while it was away are
 * not repeated: the entries they became are. Input with a key is taken once, so a
 * client may resend input whose answer it lost.
 */
export class HttpInterface implements InterfaceCapability {
	readonly id = "http";
	readonly actorId: string;
	private actor: Actor;
	private server?: Server;
	url = "";

	constructor(private api: PluginApi, private options: HttpInterfaceOptions) {
		this.actor = options.actor ?? { id: "http-user", kind: "user", authority: ["watch", "propose", "input", "answer", "approve", "tools", "cancel", "settings", "erase", "grant", "jobs", "delegate"] };
		this.actorId = this.actor.id;
	}

	async start(): Promise<void> {
		const api = this.api;
		const actor = this.actor;
		const started = await serve(
			[
				["GET", /^\/declaration$/, () => api.declaration()],
				["GET", /^\/sessions$/, (req) => api.listSessions(req.query.get("project") ?? undefined)],
				["POST", /^\/sessions$/, async (req) => ({ sessionId: await api.startSession({ settings: req.body?.settings, actor }) })],
				["POST", /^\/sessions\/([^/]+)\/open$/, async (req) => ({ sessionId: await api.openSession(req.params[0], actor) })],
				["POST", /^\/sessions\/([^/]+)\/close$/, async (req) => (await api.closeSession(req.params[0]), {})],
				["GET", /^\/sessions\/([^/]+)$/, (req) => api.session(req.params[0])],
				["GET", /^\/sessions\/([^/]+)\/history$/, (req) => api.gatedHistory(req.params[0], { all: req.query.get("all") === "1", recipient: `http:${actor.id}` })],
				["POST", /^\/sessions\/([^/]+)\/input$/, (req) => {
					if (!req.body?.content) throw new HttpError(400, "content is required");
					return api.input(req.params[0], { content: req.body.content, when: req.body.when, key: req.body.key, actorId: actor.id });
				}],
				["POST", /^\/sessions\/([^/]+)\/cancel$/, async (req) => ({ handedBack: await api.cancel(req.params[0]) })],
				["GET", /^\/sessions\/([^/]+)\/requests$/, (req) => api.openRequests(req.params[0])],
				["POST", /^\/sessions\/([^/]+)\/answers$/, (req) => api.answer(req.params[0], { ...req.body, actorId: actor.id })],
				["GET", /^\/sessions\/([^/]+)\/events$/, (req, res) => {
					const sessionId = req.params[0];
					api.session(sessionId); // refuses a session that isn't open
					const resumeFrom = req.headers["last-event-id"] ?? req.query.get("fromEntry");
					const history = api.history(sessionId, { all: true });
					const at = resumeFrom == null ? history.length - 1 : history.findIndex((entry) => entry.id === resumeFrom);
					if (resumeFrom != null && at < 0) throw new HttpError(404, "Unknown entry");
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
					res.write(": following\n\n");
					const write = (e: AgentEvent) => {
						// A recorded entry gets an id: the place to resume from after it.
						const id = e.type === "entry" || e.type === "entry.added" ? e.data?.id : undefined;
						res.write(`${id ? `id: ${id}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
					};
					const stop = api.follow(sessionId, { recipient: `http:${actor.id}`, fromEntry: at + 1 }, write);
					return new Promise<void>((resolve) => res.on("close", () => (stop(), resolve())));
				}],
			],
			{ port: this.options.port, token: this.options.token },
		);
		this.server = started.server;
		this.url = started.url;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		this.server.closeAllConnections?.();
		await new Promise<void>((resolve) => this.server!.close(() => resolve()));
	}
}

export function httpInterface(options: HttpInterfaceOptions): Plugin & { http?: HttpInterface } {
	const plugin: Plugin & { http?: HttpInterface } = {
		name: "interface-http",
		async setup(api) {
			plugin.http = new HttpInterface(api, options);
			api.provide("interface", plugin.http);
			await plugin.http.start();
		},
		stop: () => plugin.http?.stop(),
	};
	return plugin;
}
