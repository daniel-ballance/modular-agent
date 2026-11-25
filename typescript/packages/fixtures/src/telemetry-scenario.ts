import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, type Agent, type HistoryEntry, type Provider, type Session, type ToolCall, type WriterHistoryStore } from "@modular-agent/core";
import { JsonlHistoryStore } from "@modular-agent/history-jsonl";
import { HistoryArchive } from "@modular-agent/services";

export interface TelemetryRun {
  host: "typescript";
  scenario: string;
  placement: string;
  sdk: boolean;
  agentName: string;
  scenarioPath: string;
  workDir: string;
  reportPath: string;
  fixtures: { name: string; command: string[]; env: Record<string, string>; build: string; wire: string }[];
  values: { answer: string };
  parkedUrl?: string;
}

export function loadTelemetryRun(path: string): TelemetryRun {
  const run: TelemetryRun = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(run.host, "typescript");
  return run;
}

type Attempt = { id: string; model: string; beforeCrash?: true };
type Crash = { signal: "SIGKILL"; countBefore: number; turnStart: HistoryEntry };
type RestartRecord = HistoryEntry | { kind: "effect" };

class ScenarioJsonlStore extends JsonlHistoryStore {
  constructor(dir: string) {
    super(dir);
    // The SDK's default JSONL store is persistent; explicit replacements
    // declare it instead of using the SDK's default-store inference.
    Object.assign(this.supports, { persistent: true });
  }
}

export class ScenarioEvidence {
  private batches: HistoryEntry[][] = [];
  private afterRestart: RestartRecord[] = [];
  private crash?: Crash;
  private journal: string;
  private store: WriterHistoryStore;

  constructor(readonly run: TelemetryRun, recovery: boolean, private crashChild = false) {
    this.journal = join(run.workDir, "provider-attempts.ndjson");
    this.store = recovery ? new ScenarioJsonlStore(join(run.workDir, "data", "history")) : new HistoryArchive().store();
  }

  historyPlugin() {
    const store = this.store;
    const append = store.append.bind(store);
    store.append = async (sessionId, batch, options) => {
      await append(sessionId, batch, options);
      if (this.run.scenario === "first-turn") this.batches.push(structuredClone(batch));
      if (this.crash) this.afterRestart.push(...batch.filter(e => e.kind === "modular-agent.turnTrace").map(e => structuredClone(e)));
    };
    return definePlugin({ name: "scenario-history", replaces: ["history"], setup: r => r.historyStore(store) });
  }

  provider(scripted: Provider): Provider {
    return { ...scripted, request: (model, request, context) => {
      assert(context.stepId, "Scripted Provider received no step ID");
      const attempt: Attempt = { id: context.stepId, model: model.id, ...(this.crashChild ? { beforeCrash: true } : {}) };
      appendFileSync(this.journal, JSON.stringify(attempt) + "\n");
      if (this.crash && !this.afterRestart.some(e => e.kind === "effect")) this.afterRestart.push({ kind: "effect" });
      return scripted.request(model, request, context);
    } };
  }

  async beforeKill(sessionId: string, countBefore: number) {
    const { entries } = await this.store.load(sessionId);
    const turnStart = entries.findLast(e => e.kind === "turnStart");
    assert(turnStart, "No committed turnStart at the crash barrier");
    this.crash = { signal: "SIGKILL", countBefore, turnStart };
    writeFileSync(join(this.run.workDir, "before-kill.json"), JSON.stringify(this.crash));
  }

  async report(agent: Agent, session: Session, countAfter: number) {
    const id = session.id;
    const { entries } = await this.store.load(id);
    const end = entries.findLast(e => e.kind === "turnEnd");
    assert(end?.turnId);
    const report = {
      scenario: this.run.scenario, placement: this.run.placement, passed: true,
      sessionId: id, turnId: end.turnId,
      outcome: (end.data as { outcome: { kind: string } }).outcome.kind,
      historyKinds: entries.map(e => e.kind),
      ...(this.run.scenario === "first-turn" ? { declarations: { agent: agent.declaration(), session: session.declaration() } } : {}),
    };
    if (!this.run.sdk) return report;
    const question = (entries.find(e => e.kind === "inputRequest")?.data as { request: { id: string; kind: string } } | undefined)?.request;
    const modelCalls = new Set(entries.flatMap(e => e.kind === "response" && e.message?.role === "assistant"
      ? e.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []));
    const calls = entries.flatMap(e => {
      if (e.kind !== "toolResult" || e.turnId !== end.turnId || e.message?.role !== "toolResult") return [];
      const { toolCallId: id, toolName: name } = e.message;
      const { call, status } = e.data as { call?: ToolCall; status: string };
      return [{ id, name, stepId: e.stepId, status, parentCallId: call?.parentCallId,
        providerCallId: modelCalls.has(id) ? id : undefined }];
    });
    return { ...report,
      steps: readFileSync(this.journal, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Attempt),
      calls,
      ...(question ? { question: { id: question.id, kind: question.kind } } : {}),
      ...(this.run.scenario === "first-turn" ? { commits: this.batches.map(batch => {
        // First-turn has no plugins or concurrency. Each committed batch
        // identifies its writer by its record kinds and Harness work IDs.
        const { kind, turnId, stepId } = batch[0];
        const name = kind === "inputAccepted" ? "modular_agent.input.admit"
          : kind === "turnStart" || kind === "turnEnd" ? "invoke_agent"
          : stepId ? "modular_agent.step" : "modular_agent.session.open";
        return { count: batch.length, status: "committed", turnId, stepId, parent: { name, turnId, stepId } };
      }) } : {}),
      ...(this.crash ? { crash: { ...this.crash, countAfter, afterRestart: this.afterRestart } } : {}),
    };
  }
}
