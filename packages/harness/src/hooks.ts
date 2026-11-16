import type { GateAnswer, GateResult, HandlerOrder, HookRule, TransformAnswer } from "./types.js";

type Handler = (payload: any) => unknown | Promise<unknown>;
interface Registered { plugin: string; order: HandlerOrder; seq: number; handler: Handler }
interface HookPoint { name: string; owner: string; rule: HookRule; handlers: Registered[] }

const ORDER: Record<HandlerOrder, number> = { first: 0, normal: 1, last: 2 };

export interface HookFailure { hook: string; plugin: string; error: unknown }

/**
 * Hook points and their handlers. Each hook point has one fixed rule for
 * combining handlers' answers, chosen by its owner. Handlers run in plugin
 * load order; a plugin can ask to run first or last.
 */
export class HookRegistry {
	private points = new Map<string, HookPoint>();
	private seq = 0;
	constructor(private onFailure: (failure: HookFailure) => void) {}

	define(name: string, rule: HookRule, owner: string): void {
		const existing = this.points.get(name);
		if (existing) {
			if (existing.rule !== rule) throw new Error(`Hook point ${name} is already defined with rule ${existing.rule}`);
			return;
		}
		this.points.set(name, { name, owner, rule, handlers: [] });
	}

	has(name: string): boolean {
		return this.points.has(name);
	}

	rule(name: string): HookRule {
		return this.point(name).rule;
	}

	list(): { name: string; owner: string; rule: HookRule; handlers: string[] }[] {
		return [...this.points.values()].map((p) => ({ name: p.name, owner: p.owner, rule: p.rule, handlers: p.handlers.map((h) => h.plugin) }));
	}

	on(name: string, plugin: string, handler: Handler, order: HandlerOrder = "normal"): () => void {
		const point = this.point(name);
		const entry: Registered = { plugin, order, seq: this.seq++, handler };
		point.handlers.push(entry);
		point.handlers.sort((a, b) => ORDER[a.order] - ORDER[b.order] || a.seq - b.seq);
		return () => {
			point.handlers = point.handlers.filter((h) => h !== entry);
		};
	}

	removePlugin(plugin: string): void {
		for (const point of this.points.values()) point.handlers = point.handlers.filter((h) => h.plugin !== plugin);
	}

	handlers(name: string): number {
		return this.points.get(name)?.handlers.length ?? 0;
	}

	async observe(name: string, payload: unknown): Promise<void> {
		for (const h of this.point(name, "observe").handlers) {
			try {
				await h.handler(payload);
			} catch (error) {
				this.onFailure({ hook: name, plugin: h.plugin, error });
			}
		}
	}

	/** A refusal wins and stops the rest. A handler that fails counts as a refusal. */
	async gate<T>(name: string, payload: T): Promise<GateResult<T>> {
		let value = payload;
		for (const h of this.point(name, "gate").handlers) {
			let answer: GateAnswer<T>;
			try {
				answer = (await h.handler(value)) as GateAnswer<T>;
			} catch (error) {
				this.onFailure({ hook: name, plugin: h.plugin, error });
				return { refused: `${h.plugin} failed while deciding`, value };
			}
			if (!answer) continue;
			if ("refuse" in answer) return { refused: answer.refuse, value };
			if ("change" in answer) value = answer.change;
		}
		return { value };
	}

	/** Each handler gets the previous result. A handler may stop the chain. */
	async transform<T>(name: string, payload: T): Promise<{ value: T; stopped: boolean }> {
		let value = payload;
		for (const h of this.point(name, "transform").handlers) {
			let answer: TransformAnswer<T>;
			try {
				answer = (await h.handler(value)) as TransformAnswer<T>;
			} catch (error) {
				this.onFailure({ hook: name, plugin: h.plugin, error });
				continue;
			}
			if (!answer) continue;
			value = answer.value;
			if (answer.stop) return { value, stopped: true };
		}
		return { value, stopped: false };
	}

	/** The first handler that answers decides. */
	async first<R>(name: string, payload: unknown): Promise<R | undefined> {
		for (const h of this.point(name, "first").handlers) {
			try {
				const answer = await h.handler(payload);
				if (answer !== undefined) return answer as R;
			} catch (error) {
				this.onFailure({ hook: name, plugin: h.plugin, error });
			}
		}
		return undefined;
	}

	/** Every handler's contribution is gathered. */
	async collect<R>(name: string, payload: unknown): Promise<R[]> {
		const out: R[] = [];
		for (const h of this.point(name, "collect").handlers) {
			try {
				const answer = await h.handler(payload);
				if (answer !== undefined) out.push(answer as R);
			} catch (error) {
				this.onFailure({ hook: name, plugin: h.plugin, error });
			}
		}
		return out;
	}

	/** Run a hook point by its own rule. */
	async run(name: string, payload: any): Promise<any> {
		switch (this.rule(name)) {
			case "observe":
				return this.observe(name, payload);
			case "gate":
				return this.gate(name, payload);
			case "transform":
				return (await this.transform(name, payload)).value;
			case "first":
				return this.first(name, payload);
			case "collect":
				return this.collect(name, payload);
		}
	}

	/** Handlers in order, for rules the owner applies itself (such as the output gate). */
	raw(name: string): { plugin: string; handler: Handler }[] {
		return this.point(name).handlers.map((h) => ({ plugin: h.plugin, handler: h.handler }));
	}

	private point(name: string, rule?: HookRule): HookPoint {
		const point = this.points.get(name);
		if (!point) throw new Error(`Unknown hook point: ${name}`);
		if (rule && point.rule !== rule) throw new Error(`Hook point ${name} uses rule ${point.rule}, not ${rule}`);
		return point;
	}
}
