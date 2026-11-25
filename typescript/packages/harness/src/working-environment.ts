import { Session } from "./session.js";
import { type WorkingEnvironment } from "./types.js";

interface SessionEnvironmentOperations {
	use<T>(capability: string): T | undefined;
	projectOf(s: Session): string;
}

export class SessionEnvironment {
	constructor(private readonly operations: SessionEnvironmentOperations) {}

	scopedEnvironment(env: WorkingEnvironment, check: () => void): WorkingEnvironment {
		return new Proxy(env, {
			get: (environment, key) => {
				const member: unknown = Reflect.get(environment, key, environment);
				if (typeof member !== "function") return member;
				if (key === "at" || key === "forSession") return async (...args: unknown[]) => {
					check();
					const next = await member.apply(environment, args) as WorkingEnvironment;
					check();
					return this.scopedEnvironment(next, check);
				};
				return (...args: unknown[]) => {
					check();
					const result: unknown = member.apply(environment, args);
					// A read begun before a revocation cannot disclose its reply afterwards.
					if (key === "readFile" || key === "exists" || key === "list" || key === "hasPoint") {
						return Promise.resolve(result).then(value => { check(); return value; });
					}
					return result;
				};
			},
		});
	}

	/** The working environment, in the session's project when it has its own. */
	async environmentFor(s: Session): Promise<WorkingEnvironment | undefined> {
		const base = this.operations.use<WorkingEnvironment>("working-environment");
		const env = await base?.forSession?.(s.id) ?? base;
		const cwd = this.operations.projectOf(s);
		return env && env.cwd !== cwd && env.at ? env.at(cwd) : env;
	}
}
