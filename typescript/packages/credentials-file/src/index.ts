import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { advanceSecretSlot, secretStaging, type SecretFile, type CredentialStore, type Plugin } from "@modular-agent/harness";

const metadata = "$modular-agent.staging";
type File = SecretFile & { values: Data };
type Data = Record<string, { type: string; [key: string]: unknown }>;

/**
 * Credentials in a JSON file, one per provider, in the same format and with the
 * same file lock as Pi's auth.json, so the two can safely share one file.
 */
export class FileCredentialStore implements CredentialStore {
	constructor(private path: string) {}
	private readonly stages = secretStaging(async () => this.load(), (change) => this.update(change),
		(file, name, value) => { file.values[name] = { type: "api_key", key: value }; });
	stage: NonNullable<CredentialStore["stage"]> = (scope, value) => scope.credential === metadata ? Promise.resolve(undefined) : this.stages.stage(scope, value);
	lookupStaged = this.stages.lookupStaged;
	activate = this.stages.activate;
	discard = this.stages.discard;

	private ensure(): string {
		if (!existsSync(this.path)) {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, "{}", { mode: 0o600 });
		}
		return realpathSync(this.path);
	}

	private load(): File {
		const raw = existsSync(this.path) ? readFileSync(this.path, "utf8").replace(/^\uFEFF/, "").trim() : "";
		const values = Object.assign(Object.create(null), raw ? JSON.parse(raw) : {});
		const staging = values[metadata];
		delete values[metadata];
		return { values, staging };
	}

	async read(providerId: string): Promise<unknown | undefined> {
		return this.load().values[providerId];
	}

	async list(): Promise<readonly { providerId: string; type: string }[]> {
		return Object.entries(this.load().values).map(([providerId, c]) => ({ providerId, type: c.type }));
	}

	/** The only write path: a read-modify-write under the file lock. */
	async modify(providerId: string, fn: (current: any) => Promise<any>): Promise<unknown | undefined> {
		if (providerId === metadata) throw new Error("Reserved credential name");
		return this.update(async data => {
			const next = await fn(data.values[providerId]);
			if (next === undefined) delete data.values[providerId];
			else data.values[providerId] = next;
			advanceSecretSlot(data, providerId);
			return next;
		});
	}

	private async update<T>(change: (data: File) => Promise<T>): Promise<T> {
		const path = this.ensure();
		const release = await lockfile.lock(path, { retries: { retries: 20, minTimeout: 25, maxTimeout: 500 }, stale: 30_000 });
		const temporary = path + "." + randomUUID() + ".tmp";
		try {
			const data = this.load(), result = await change(data);
			await using file = await open(temporary, "wx", 0o600);
			await file.writeFile(JSON.stringify({ ...data.values, [metadata]: data.staging }, null, 2));
			await file.sync();
			await rename(temporary, path);
			await using directory = await open(dirname(path), "r");
			await directory.sync();
			return result;
		} finally {
			try { await rm(temporary, { force: true }); } finally { await release(); }
		}
	}

	async delete(providerId: string): Promise<void> {
		await this.modify(providerId, async () => undefined);
	}
}

/**
 * Settings: "path" for the credentials file, or "usePiAuth": true to share
 * Pi's ~/.pi/agent/auth.json.
 */
export function fileCredentials(options: { path?: string } = {}): Plugin {
	return {
		name: "credentials-file",
		setup(api) {
			const settings = api.config();
			const path =
				options.path ??
				(settings.path as string | undefined) ??
				(settings.usePiAuth ? join(homedir(), ".pi", "agent", "auth.json") : join(api.home, "auth.json"));
			api.provide("credential-store", new FileCredentialStore(path));
		},
	};
}
