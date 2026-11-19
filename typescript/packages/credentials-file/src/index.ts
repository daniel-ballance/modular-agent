import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { CredentialStore, Plugin } from "@modular-agent/harness";

type Data = Record<string, { type: string; [key: string]: unknown }>;

/**
 * Credentials in a JSON file, one per provider, in the same format and with the
 * same file lock as Pi's auth.json, so the two can safely share one file.
 */
export class FileCredentialStore implements CredentialStore {
	constructor(private path: string) {}

	private ensure(): string {
		if (!existsSync(this.path)) {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, "{}", { mode: 0o600 });
		}
		return realpathSync(this.path);
	}

	private load(): Data {
		if (!existsSync(this.path)) return {};
		const raw = readFileSync(this.path, "utf8").replace(/^\uFEFF/, "").trim();
		return raw ? (JSON.parse(raw) as Data) : {};
	}

	async read(providerId: string): Promise<unknown | undefined> {
		return this.load()[providerId];
	}

	async list(): Promise<readonly { providerId: string; type: string }[]> {
		return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
	}

	/** The only write path: a read-modify-write under the file lock. */
	async modify(providerId: string, fn: (current: any) => Promise<any>): Promise<unknown | undefined> {
		const path = this.ensure();
		const release = await lockfile.lock(path, { retries: { retries: 20, minTimeout: 25, maxTimeout: 500 }, stale: 30_000 });
		try {
			const data = this.load();
			const next = await fn(data[providerId]);
			if (next === undefined) delete data[providerId];
			else data[providerId] = next;
			writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
			return next;
		} finally {
			await release();
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
