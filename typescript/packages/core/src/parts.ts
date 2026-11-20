import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { CredentialStore, Runtime, WorkingEnvironment } from "@modular-agent/harness";
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
  return readOnly(async id => {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!handle) return undefined;
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
        throw new AgentError("invalid_request", "The credential file must be private to its owner");
      }
      const values = JSON.parse(await handle.readFile("utf8"));
      return values && Object.hasOwn(values, id) ? values[id] : undefined;
    } finally { await handle.close(); }
  });
}

export type { Configuration, CredentialStore, HistoryStore, Runtime, RuntimeHost, WorkingEnvironment } from "@modular-agent/harness";