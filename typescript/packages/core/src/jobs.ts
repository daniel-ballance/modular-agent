import type { JobHandle } from "@modular-agent/harness";
import type { Input } from "./data.js";
import { AgentError, checked } from "./errors.js";

export type JobOutcome = { kind: "completed" | "cancelled" } | { kind: "failed"; error: string };
export interface UnfinishedJob { id: string; kind: string; detail: unknown; key?: string; actorId?: string }
export interface JobOwner {
  /** Erasure cleanup supplies identity only, with an inert handle. */
  cancel(job: UnfinishedJob, context: { job: Job }): void | Promise<void>;
  resume?(job: UnfinishedJob, context: { job: Job }): void | Promise<void>;
}
export interface Job {
  readonly id: string;
  readonly started: boolean;
  progress(content: Input): void;
  end(outcome: JobOutcome, result?: Input, report?: boolean): Promise<void>;
}
export interface JobStarter { start(kind: string, detail: unknown, key?: string): Promise<Job> }
export interface JobRecovery {
  unfinished(): Promise<UnfinishedJob[]>;
  resume(job: UnfinishedJob): Promise<Job>;
}

export function sdkJob(handle: JobHandle): Job {
  let state: "open" | "ending" | "ended" = "open";
  const check = () => {
    if (!handle.started || state !== "open") throw new AgentError("invalid_request", "Job is not active in this execution");
  };
  return {
    id: handle.id, started: handle.started,
    progress(content) { check(); handle.progress(structuredClone(content)); },
    async end(outcome, result, report = false) {
      check();
      state = "ending";
      try {
        await checked(() => handle.finish(outcome.kind, structuredClone(result), {
          report, error: outcome.kind === "failed" ? outcome.error : undefined,
        }), "invalid_request");
        state = "ended";
      } catch (error) { state = "open"; throw error; }
    },
  };
}
