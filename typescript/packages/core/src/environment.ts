import { resolve } from "node:path";
import type { WorkingEnvironment } from "@modular-agent/harness";
import { AgentError } from "./errors.js";

type Execution = { exitCode: number | null; output: string; timedOut: boolean };
type Handler = (args: string, signal: AbortSignal) => Execution | Promise<Execution>;

export let asWorkingEnvironment: (memory: MemoryEnvironment) => WorkingEnvironment;
export class MemoryEnvironment {
  #files = new Map<string, Buffer>();
  #commands = new Map<string, Handler>();
  constructor(files: Record<string, string | Uint8Array> = {}) {
    for (const [name, value] of Object.entries(files)) this.#files.set(resolve("/", name), Buffer.from(value as Uint8Array));
  }
  onExec(name: string, handler: Handler): void { this.#commands.set(name, handler); }
  static { asWorkingEnvironment = memory => ({
    id: "memory", cwd: "/", containment: "none", confinesFiles: true, safeToRepeat: false,
    async readFile(path) {
      const value = memory.#files.get(resolve("/", path));
      if (!value) throw new AgentError("not_found", `No file ${path}`);
      return Buffer.from(value);
    },
    async writeFile(path, data) { memory.#files.set(resolve("/", path), Buffer.from(data as Uint8Array)); },
    async exists(path) { return memory.#files.has(resolve("/", path)); },
    async list(path) {
      const absolute = resolve("/", path);
      if (memory.#files.has(absolute)) throw new AgentError("invalid_request", "The path is not a directory");
      const prefix = absolute === "/" ? absolute : absolute + "/";
      const entries = new Map<string, "directory" | "file">();
      for (const file of memory.#files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        if (name) entries.set(name, rest.length ? "directory" : "file");
      }
      if (!entries.size && absolute !== "/") throw new AgentError("not_found", "No such directory");
      return [...entries].map(([name, kind]) => ({ name, kind }));
    },
    async exec(command, { signal, timeoutMs, onOutput }) {
      const [, name, args] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim()) ?? [];
      const run = memory.#commands.get(name);
      if (!run) throw new AgentError("not_supported", `No test command ${name}`);
      const deadline = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
      const cancellation = deadline ? AbortSignal.any([deadline, signal]) : signal;
      cancellation.throwIfAborted();
      const result = await run(args ?? "", cancellation);
      onOutput?.(result.output);
      return result;
    },
  }); }
}
export const memoryEnvironment = (files?: Record<string, string | Uint8Array>) => new MemoryEnvironment(files);
