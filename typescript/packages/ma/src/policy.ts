import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defaultAcpActor, type AcpActorToken, type Actor, type ReservationOptions, type ServeAcpOptions } from "@modular-agent/core";

const MiB = 1024 * 1024;
const limits = {
  session: { inputs: 32, calls: 64, jobs: 16, bufferedBytes: 16 * MiB, storageBytes: 1024 * MiB, controlBytes: 8 * MiB },
  tenant: { inputs: 128, calls: 256, jobs: 64, bufferedBytes: 64 * MiB, storageBytes: 8192 * MiB, controlBytes: 32 * MiB },
  agent: { inputs: 512, calls: 1024, jobs: 256, bufferedBytes: 256 * MiB, storageBytes: 32768 * MiB, controlBytes: 128 * MiB },
};
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const rights = new Set<unknown>(defaultAcpActor().rights);
const scopes = ["session", "tenant", "agent"] as const;

function object(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const unexpected = Object.keys(value).find(key => !fields.includes(key));
  if (unexpected !== undefined) throw new Error(`${name} has an unknown field: ${unexpected}`);
  return value as Record<string, unknown>;
}
function list<T>(value: unknown, valid: (item: unknown) => item is T, name: string): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(valid)) throw new Error(`Invalid ${name} list`);
  return value;
}

async function principal(value: unknown, name: string, network = false) {
  const config = object(value, ["actor", "tenants", "projects", "represents", "traceTrusted", ...(network ? ["tokenFile", "clientId"] : [])], name);
  const { traceTrusted = !network } = config;
  if (typeof traceTrusted !== "boolean") throw new Error(`${name}.traceTrusted must be a boolean`);
  const actor = object(config.actor, ["id", "kind", "rights"], `${name}.actor`);
  if (!id(actor.id) || !["host", "user", "agent", "program"].includes(String(actor.kind))) throw new Error(`Invalid ${name}.actor identity`);
  const allowed = list(actor.rights, (r): r is Actor["rights"][number] => rights.has(r), `${name}.actor.rights`);
  if (!allowed) throw new Error(`${name}.actor.rights is required`);
  const represents = list(config.represents, id, `${name}.represents`);
  if (represents?.length) throw new Error(`${name}.represents must be empty for ma`);
  const projects = list(config.projects, (item): item is string => id(item) && isAbsolute(item), `${name}.projects`);
  const tenants = list(config.tenants, (item): item is string | null => item === null || id(item), `${name}.tenants`);
  return {
    actor: { id: actor.id, kind: actor.kind as Actor["kind"], rights: allowed }, tenants, represents, traceTrusted,
    projects: projects && await Promise.all(projects.map(async path => {
      try {
        const canonical = await realpath(path);
        if (!(await stat(canonical)).isDirectory()) throw new Error();
        return canonical;
      } catch { throw new Error(`${name}.projects contains an unavailable directory: ${path}`); }
    })),
    tokenFile: config.tokenFile,
    clientId: config.clientId,
  };
}

export async function loadPolicy(config: string, options: { policy?: string; listen?: string; tokenFile?: string; agui?: boolean }): Promise<{
  approvalWaitMaxMs?: number; stdio?: ServeAcpOptions; actors?: (AcpActorToken & { clientId?: string })[]; resourceReservations: ReservationOptions;
}> {
  const path = options.policy === undefined ? join(config, "policy.json") : resolve(options.policy);
  try {
    const data = await readFile(path, "utf8").catch(error => {
      if (options.policy === undefined && error.code === "ENOENT") return "{}";
      throw error;
    });
    const value = object(JSON.parse(data), ["stdio", "actors", "limits", "approvalWaitMaxMs"], "policy");
    const { approvalWaitMaxMs } = value;
    if (approvalWaitMaxMs !== undefined && (typeof approvalWaitMaxMs !== "number" || !Number.isSafeInteger(approvalWaitMaxMs) || approvalWaitMaxMs <= 0)) {
      throw new Error("approvalWaitMaxMs must be a positive integer in milliseconds");
    }
    const stdio = value.stdio === undefined ? undefined : await principal(value.stdio, "stdio");
    let actors: (AcpActorToken & { clientId?: string })[] | undefined;
    if (value.actors !== undefined) {
      if (!Array.isArray(value.actors) || !value.actors.length) throw new Error("actors must be a nonempty list");
      if (options.listen && options.tokenFile !== undefined) throw new Error("actors and --token-file cannot be combined");
      const tokens = new Set<string>();
      actors = [];
      for (const [index, entry] of value.actors.entries()) {
        const { tokenFile: name, clientId, ...scope } = await principal(entry, `actors[${index}]`, true);
        if (!id(name)) throw new Error(`actors[${index}].tokenFile is required`);
        const tokenFile = resolve(dirname(path), name);
        const info = await stat(tokenFile);
        if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`actors[${index}].tokenFile must be a private file`);
        const token = (await readFile(tokenFile, "utf8")).trim();
        if (Buffer.byteLength(token) < 16 || /[^\x21-\x7e]/.test(token) || tokens.has(token)) throw new Error("actors must use distinct valid tokens");
        tokens.add(token);
        if ((options.agui || clientId !== undefined) && !id(clientId)) throw new Error(`actors[${index}].clientId must be a nonempty string`);
        actors.push({ ...scope, tokenFile, ...(id(clientId) ? { clientId } : {}) });
      }
    }
    if (options.listen !== undefined && !actors && !options.tokenFile) throw new Error("--listen needs policy actors or --token-file");
    const configured = value.limits === undefined ? {} : object(value.limits, scopes, "limits");
    const resourceReservations = structuredClone(limits);
    for (const scope of scopes) if (configured[scope] !== undefined) {
      const keys = Object.keys(limits[scope]) as (keyof typeof limits.session)[];
      const bounds = object(configured[scope], keys, `limits.${scope}`);
      for (const key of keys) {
        if (!Object.hasOwn(bounds, key)) continue;
        const count = bounds[key];
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`limits.${scope}.${key} must be a nonnegative integer`);
        resourceReservations[scope][key] = count;
      }
      if (resourceReservations[scope].controlBytes > resourceReservations[scope].storageBytes) throw new Error(`limits.${scope}.controlBytes exceeds storageBytes`);
    }
    return { stdio, actors, resourceReservations, approvalWaitMaxMs };
  } catch (error) { throw new Error(`Policy ${path}: ${(error as Error).message}`); }
}
