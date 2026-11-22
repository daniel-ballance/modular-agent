import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialStore, SecretScope, SecretReceipt } from "./types.js";

type Stage = { receipt: SecretReceipt; generation: string | null; value?: string; decision?: "activated" | "superseded" };
export interface SecretState {
	generations: Record<string, string>;
	requests: Record<string, Stage | null>;
}
export interface SecretFile { staging?: SecretState }
export type SecretTransaction<T extends SecretFile> = <R>(change: (data: T) => Promise<R>) => Promise<R>;
const scopeKey = ({ deployment, sessionId, requestId }: SecretScope) => JSON.stringify([deployment, sessionId, requestId]);
const state = (data: SecretFile) => data.staging ??= { generations: Object.create(null), requests: Object.create(null) };
const generation = (data: SecretFile, name: string) => Object.hasOwn(state(data).generations, name) ? state(data).generations[name] : null;
export function advanceSecretSlot(data: SecretFile, name: string): void {
	Object.defineProperty(state(data).generations, name, { value: randomUUID(), enumerable: true, writable: true, configurable: true });
}

/** Staging and active slots share one locked, durable file transaction. */
export function secretStaging<T extends SecretFile>(read: () => Promise<T>, update: SecretTransaction<T>, put: (file: T, name: string, value: string) => void): Required<Pick<CredentialStore, "stage" | "lookupStaged" | "activate" | "discard">> {
	return {
		stage: (scope, value) => update(async data => {
			const key = scopeKey(scope), requests = state(data).requests;
			if (Object.hasOwn(requests, key)) return undefined;
			const receipt = { ...scope, receipt: randomUUID() };
			requests[key] = { receipt, generation: generation(data, scope.credential), value };
			return { ...receipt };
		}),
		async lookupStaged(scope) {
			const receipt = (await read()).staging?.requests[scopeKey(scope)]?.receipt;
			return receipt && { ...receipt };
		},
		activate: scope => update(async data => {
			const row = state(data).requests[scopeKey(scope)];
			if (!row) throw new Error("No staged secret for this request");
			if (row.decision) return row.decision;
			const name = row.receipt.credential;
			if (generation(data, name) === row.generation) {
				put(data, name, row.value!);
				advanceSecretSlot(data, name);
				row.decision = "activated";
			} else row.decision = "superseded";
			delete row.value;
			return row.decision;
		}),
		discard: scope => update(async data => {
			const key = scopeKey(scope), requests = state(data).requests;
			if (!requests[key]?.decision) requests[key] = null;
		}),
	};
}

/** A kernel lock, released even on SIGKILL. The lock file itself is never removed. */
export async function withCredentialLock<T>(path: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await using file = await open(path, "a", 0o600);
	await new Promise<void>((resolve, reject) => {
		// macOS has flock(2) but no flock(1). Its system Perl exposes the same
		// lock as Rust. In both cases the inherited open file description keeps
		// the lock held in Node after the helper exits, until Node closes it.
		const lock = process.platform === "darwin"
			? spawn("/usr/bin/perl", ["-MFcntl=:flock", "-e", 'open(my $fd, "<&=3") or die $!; flock($fd, LOCK_EX) or die $!;'],
				{ stdio: ["ignore", "ignore", "ignore", file.fd], signal, env: {} })
			: spawn("flock", ["-x", "3"], { stdio: ["ignore", "ignore", "ignore", file.fd], signal });
		lock.once("error", reject);
		lock.once("close", code => code === 0 ? resolve() : reject(new Error("Could not lock the credential file")));
	});
	signal?.throwIfAborted();
	return await work();
}
