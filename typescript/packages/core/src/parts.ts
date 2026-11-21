import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { advanceSecretSlot, secretStaging, withCredentialLock, type SecretFile, type CredentialStore, type Runtime, type WorkingEnvironment } from "@modular-agent/harness";
import { GitPoints, LocalEnvironment } from "@modular-agent/env-local";
import { DurableRuntime } from "@modular-agent/runtime-durable";
import { TransientRuntime } from "@modular-agent/runtime-transient";
import { AgentError } from "./errors.js";

export const transientRuntime = (): Runtime => new TransientRuntime();
export const durableRuntime = (): Runtime => new DurableRuntime();
export function localEnvironment(root = process.cwd()): WorkingEnvironment {
  const cwd = resolve(root);
  return new LocalEnvironment(cwd, undefined, undefined, new GitPoints());
}

function readOnly(read: CredentialStore["read"]): CredentialStore {
  const readonly = async (): Promise<never> => { throw new AgentError("not_supported", "This credential store is read-only"); };
  return { read, list: async () => [], modify: readonly, delete: readonly };
}
export const environmentCredentials = (): CredentialStore => readOnly(async id =>
  process.env[`${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`]);

export function fileCredentials(path: string): CredentialStore {
  const absolute = resolve(path);
  const metadata = "$modular-agent.staging";
  type File = SecretFile & { values: Record<string, unknown> };
  const read = async (): Promise<File> => {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!handle) return { values: Object.create(null) };
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
        throw new AgentError("invalid_request", "The credential file must be private to its owner");
      }
      let values;
      try {
        values = JSON.parse(await handle.readFile("utf8"));
        if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error();
      } catch { throw new AgentError("invalid_request", "The credential file is not a JSON object"); }
      const staging = values[metadata];
      delete values[metadata];
      return { values: Object.assign(Object.create(null), values), staging };
    } finally { await handle.close(); }
  };
  const update = <T>(change: (data: File) => Promise<T>, signal?: AbortSignal) =>
    withCredentialLock(absolute + ".lock", async () => {
      const data = await read();
      const result = await change(data);
      signal?.throwIfAborted();
      const temporary = absolute + "." + randomUUID() + ".tmp";
      try {
        await using file = await open(temporary, "wx", 0o600);
        await file.writeFile(JSON.stringify({ ...data.values, [metadata]: data.staging }));
        await file.sync();
        await rename(temporary, absolute);
        await using directory = await open(dirname(absolute), "r");
        await directory.sync();
      } finally { await rm(temporary, { force: true }); }
      return result;
    }, signal);
  const check = (name: string) => {
    if (!name || name === metadata) throw new AgentError("invalid_request", "Invalid credential name");
  };
  const put = (data: File, name: string, value: string) => { check(name); data.values[name] = value; };
  return {
    ...secretStaging(read, update, put),
    async read(name) { check(name); return (await read()).values[name]; },
    async list() {
      return Object.entries((await read()).values).map(([providerId, value]) => ({
        providerId, type: (value as { type?: string } | null)?.type ?? "api_key",
      }));
    },
    async modify(name, change, options) {
      check(name);
      return update(async data => {
        const value = await change(data.values[name]);
        if (value === undefined) delete data.values[name];
        else data.values[name] = value;
        advanceSecretSlot(data, name);
        return value;
      }, options?.signal);
    },
    async delete(name, options) {
      check(name);
      await update(async data => { delete data.values[name]; advanceSecretSlot(data, name); }, options?.signal);
    },
  };
}

/** Helpers for writable credential stores with an existing private file format. */
export { advanceSecretSlot, secretStaging, withCredentialLock } from "@modular-agent/harness";
export type { LeasedHistoryStore as HistoryStore, HistoryMetadata } from "@modular-agent/services";
export type { Configuration, CredentialStore, HistoryStore as WriterHistoryStore, Runtime, RuntimeHost, SecretFile, SecretReceipt, SecretScope, SecretSubmission, WorkingEnvironment } from "@modular-agent/harness";