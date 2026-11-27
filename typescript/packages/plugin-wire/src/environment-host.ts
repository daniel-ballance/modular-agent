import type { DirEntry, ExecResult, WorkingEnvironment } from "@modular-agent/harness";
import { execTimeout, notFoundAsEnoent, optionalMethod, type WirePeer } from "./wire.js";

export class WireEnvironment implements WorkingEnvironment {
	readonly id: string;
	constructor(private peer: WirePeer, readonly cwd: string, readonly containment: string, readonly points: boolean,
		private sessionId?: string, readonly confinesFiles = false) {
		this.id = `plugin:${cwd}`;
	}
	at(cwd: string): WorkingEnvironment {
		return new WireEnvironment(this.peer, cwd, this.containment, this.points, this.sessionId, this.confinesFiles);
	}
	forSession(sessionId: string): WorkingEnvironment {
		return new WireEnvironment(this.peer, this.cwd, this.containment, this.points, sessionId, this.confinesFiles);
	}
	get safeToRepeat(): boolean { return this.containment === "strong"; }
	async save(): Promise<string> {
		return (await this.peer.request<{ point: string }>("env/save", { cwd: this.cwd, sessionId: this.sessionId })).point;
	}
	async hasPoint(point: string): Promise<boolean> {
		return (await this.peer.request<{ exists: boolean }>("env/checkPoint", { cwd: this.cwd, sessionId: this.sessionId, point })).exists === true;
	}
	async restore(point: string): Promise<void> {
		await this.peer.request("env/restore", { cwd: this.cwd, sessionId: this.sessionId, point });
	}
	async sessionEnded(sessionId: string): Promise<void> {
		await this.peer.request("env/sessionEnded", { sessionId });
	}
	async readFile(path: string): Promise<Buffer> {
		try {
			return Buffer.from((await this.peer.request<{ data: string }>("env/read", { cwd: this.cwd, sessionId: this.sessionId, path })).data, "base64");
		} catch (error) {
			throw notFoundAsEnoent(error, path);
		}
	}
	async writeFile(path: string, data: string | Buffer): Promise<void> {
		await this.peer.request("env/write", { cwd: this.cwd, sessionId: this.sessionId, path, data: Buffer.from(data).toString("base64") });
	}
	async list(path: string): Promise<DirEntry[]> {
		return (await this.peer.request<{ entries: DirEntry[] }>("env/list", { cwd: this.cwd, sessionId: this.sessionId, path }).catch(optionalMethod)).entries;
	}
	async exists(path: string): Promise<boolean> {
		return (await this.peer.request<{ exists: boolean }>("env/exists", { cwd: this.cwd, sessionId: this.sessionId, path })).exists;
	}
	async exec(command: string, options: { signal: AbortSignal; timeoutMs?: number; onOutput?(chunk: string): void }): Promise<ExecResult> {
		const req = this.peer.request<ExecResult>("env/exec", { cwd: this.cwd, sessionId: this.sessionId, command, timeoutMs: execTimeout(options.timeoutMs) }, options.signal);
		const listen = (p: { parentRequestId: number; chunk: string }) => {
			if (p.parentRequestId === req.id) options.onOutput?.(p.chunk);
		};
		WireEnvironment.listen(this.peer, req.id, listen);
		try {
			return await req;
		} catch (error) {
			if (options.signal.aborted) return { exitCode: null, output: "", timedOut: false };
			throw error;
		} finally {
			WireEnvironment.listeners.get(this.peer)?.delete(req.id);
		}
	}
	static listeners = new WeakMap<WirePeer, Map<number, (p: any) => void>>();
	static listen(peer: WirePeer, id: number, fn: (p: any) => void): void {
		let m = WireEnvironment.listeners.get(peer);
		if (!m) {
			m = new Map();
			WireEnvironment.listeners.set(peer, m);
			const all = m;
			peer.onNotification("env/output", (p) => all.get(p?.parentRequestId)?.(p));
		}
		m.set(id, fn);
	}
}
