import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, fileHistory, AgentError, httpHistory, type HistoryEntry, type WriterHistoryStore } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";
import { fileURLToPath } from "node:url";

export type Selection = "file" | "http" | "custom";
export type Placement = "local" | "served";

// Unlike a leased Registrar port, this writer does not stage anything on behalf of the SDK.
export function recordingStore(dir: string) {
  type Record = Awaited<ReturnType<WriterHistoryStore["load"]>> & { batches: HistoryEntry[][] };
  const path = (id: string) => join(dir, `${id}.json`);
  const get = (id: string): Record => {
    if (!existsSync(path(id))) throw new AgentError("not_found", "Unknown session");
    return JSON.parse(readFileSync(path(id), "utf8"));
  };
  const put = (id: string, row: Record) => {
    mkdirSync(dir, { recursive: true });
    const staged = `${path(id)}.tmp`;
    writeFileSync(staged, JSON.stringify(row));
    renameSync(staged, path(id));
  };
  const store: WriterHistoryStore = {
    supports: { persistent: true, portableSessions: true },
    async create(meta) { put(meta.id, { meta, entries: [], batches: [] }); },
    async openForWriting(id) { get(id); },
    async close() {},
    async append(id, entries) {
      const row = get(id);
      row.entries.push(...entries);
      row.batches.push(entries);
      put(id, row);
    },
    async load(id) { return get(id); },
    async list() {
      return (existsSync(dir) ? readdirSync(dir) : []).filter(name => name.endsWith(".json"))
        .map(name => get(name.slice(0, -5))).filter(row => row.entries.length).map(row => row.meta);
    },
  };
  return { store, get, exists: (id: string) => existsSync(path(id)) };
}

export function composition(root: string, selection: Selection, placement: Placement, url: string) {
  const dir = join(root, "history");
  const plugin = definePlugin({ name: "test-store", replaces: ["history"],
    setup: r => r.historyStore(recordingStore(dir).store) });
  return testAgent({
    project: root, dataDir: join(root, "data"), durability: "kept", severalActors: true, sessionLimits: true,
    tenants: { demo: { rights: ["watch", "input", "settings", "grant", "administer"] } },
    script: [{ text: "done" }],
    ...(selection === "custom" ? { plugins: [plugin] } : {
      history: selection === "file" ? fileHistory(dir) : httpHistory(url, join(root, "token")),
    }),
    processPlugins: placement === "served" ? [{
      command: [process.execPath, fileURLToPath(new URL("../../../../plugin-wire/dist/src/serve-cli.js", import.meta.url))],
      env: { MODULAR_AGENT_PLUGIN_PARTS: "runtime" },
    }] : undefined,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, selection, placement, url] = process.argv.slice(2);
  const agent = await composition(root, selection as Selection, placement as Placement, url);
  const session = await agent.session({ tenant: "demo", settings: { maxSteps: 4 } });
  process.stdout.write(`${session.id}\n`);
  // Keep the process alive until the test sends SIGKILL. No close hooks run.
  process.stdin.resume();
}
