import { text, type ToolContext as BaseContext, type ToolSource } from "@modular-agent/harness";
import type { Content, Input, QuestionDraft, QuestionReply, ToolDefinition, ToolStatus } from "./data.js";
import { AgentError, checked, messageOf, sdkError } from "./errors.js";
import { schema, type Infer, type Schema } from "./schema.js";
import { sdkJob, type JobStarter } from "./jobs.js";
import type { CallContext } from "./plugin.js";

export interface ToolEnvironment {
  read(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<import("@modular-agent/harness").DirEntry[]>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  exec(command: string, options?: { timeout?: number }): Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;
}
export interface ToolContext extends Pick<CallContext, "history" | "emit"> {
  sessionId: string;
  actorId?: string;
  callId: string;
  stepId?: string;
  cancelled: AbortSignal;
  /** In process only. Declare inProcessOnly when using this member. */
  credential(name: string): Promise<string | undefined>;
  environment: ToolEnvironment;
  jobs: JobStarter;
  tools: {
    list(): Promise<ToolDefinition[]>;
    call(name: string, input: Record<string, unknown>): Promise<import("@modular-agent/harness").ToolResult>;
  };
  refuse(reason: string): never;
  ask(question: QuestionDraft, wait?: { wait: number; then: "leaveOpen" }): Promise<QuestionReply>;
  progress(content: Input): void;
  log(message: string): void;
}
export interface ToolOutput {
  status?: "completed" | "failed" | "refused" | "outcomeUnknown" | "cancelled";
  content: Content;
  value?: unknown;
}
type ToolOptions<S extends Schema> = {
  name: string;
  description: string;
  input: S;
  output?: Schema;
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  safeToRepeat?: boolean;
  parallel?: boolean;
  callers?: ToolDefinition["callers"];
  presentation?: unknown;
  inProcessOnly?: boolean;
  run(input: Infer<S>, context: ToolContext): unknown;
};
type Settled = { status: ToolStatus; content: Content; value?: unknown };
/** Thrown by ask when the host leaves the call pending after its wait. */
export class LeftOpen extends Error {}
const body = new WeakMap<Tool, (input: unknown, context: ToolContext) => Promise<Settled | { pending: string }>>();
class Refusal extends Error {}

export class Tool {
  private constructor(readonly definition: ToolDefinition, readonly inProcessOnly: boolean) {}

  static create<const S extends Schema>(options: ToolOptions<S>): Tool {
    if (!options.name || typeof options.name !== "string" || typeof options.description !== "string" || typeof options.run !== "function") {
      throw new AgentError("invalid_params", "A tool needs a name, description and function");
    }
    let input: ReturnType<typeof schema>;
    let output: ReturnType<typeof schema> | undefined;
    try { input = schema(options.input); output = options.output && schema(options.output); }
    catch (error) { throw sdkError(error, "invalid_params"); }
    const definition: ToolDefinition = {
      name: options.name, description: options.description, parameters: input.parameters,
      ...(output ? { returns: output.parameters } : {}),
      hints: {
        readOnly: options.readOnly ?? false, destructive: options.destructive ?? true,
        openWorld: options.openWorld ?? true, safeToRepeat: options.safeToRepeat ?? false,
      },
      parallel: options.parallel ?? false,
      callers: options.callers ?? ["model", "ui", "plugin"],
      ...(options.presentation !== undefined ? { display: options.presentation } : {}),
    };
    const tool = new Tool(definition, options.inProcessOnly ?? false);
    body.set(tool, async (raw, context) => {
      try {
        context.cancelled.throwIfAborted();
        const run: (input: never, context: ToolContext) => unknown = options.run;
        const value = await run(await input.parse(raw) as never, context);
        context.cancelled.throwIfAborted();
        const out: Settled = typeof value === "string" && !output ? { status: "completed", content: [text(value)] }
          : value && typeof value === "object" && Array.isArray((value as ToolOutput).content)
            ? { ...(value as ToolOutput), status: (value as ToolOutput).status ?? "completed" }
            : !output && Array.isArray(value) && value.every(p => p && typeof p.type === "string")
              ? { status: "completed", content: value }
              : { status: "completed", content: value === undefined ? [] : [text(JSON.stringify(value))], value };
        if (!["completed", "failed", "refused", "outcomeUnknown", "cancelled"].includes(out.status)) {
          throw new AgentError("invalid_request", "Invalid tool status");
        }
        if (!out.content.every(p => p && typeof p.type === "string")) throw new AgentError("invalid_request", "Invalid tool result content");
        if (out.status !== "completed" && !out.content.length) out.content = [text({
          failed: "Tool failed", refused: "Tool refused", cancelled: "Cancelled", outcomeUnknown: "The tool outcome is unknown",
        }[out.status as "failed" | "refused" | "cancelled" | "outcomeUnknown"])];
        if (out.value !== undefined) {
          // Use the same JSON value locally that a served tool sends.
          const encoded = JSON.stringify(out.value);
          if (encoded === undefined) throw new AgentError("invalid_request", "Tool value is not JSON");
          out.value = JSON.parse(encoded);
        }
        return out;
      } catch (error) {
        if (context.cancelled.aborted) return { status: "cancelled", content: [text("Cancelled")] };
        if (error instanceof LeftOpen) return { pending: error.message };
        if (error instanceof Refusal) return { status: "refused", content: [text(error.message)] };
        return { status: "failed", content: [text(`Tool failed: ${messageOf(error)}`)] };
      }
    });
    return tool;
  }
}
export const tool = Tool.create;

export function asContent(input: Input): Content {
  return typeof input === "string" ? [text(input)] : input;
}

interface ToolCallbacks extends Pick<ToolContext, "history" | "emit" | "credential"> {
  finish(): void;
}

export function toolSource(name: string, tools: Tool[], scope: (base: BaseContext) => ToolCallbacks): ToolSource {
  return {
    id: name,
    tools: () => tools.map(t => structuredClone(t.definition)),
    async run(call, base) {
      const tool = tools.find(t => t.definition.name === call.name);
      if (!tool) throw new AgentError("invalid_request", `Unknown tool ${call.name}`);
      let live = true;
      const check = () => {
        if (!live) throw new AgentError("invalid_request", "Tool context has settled");
        if (base.signal.aborted) throw new AgentError("cancelled", "Tool was cancelled");
      };
      const environment = () => {
        check();
        if (!base.environment) throw new AgentError("not_supported", "No working environment");
        return base.environment;
      };
      const { finish, ...callbacks } = scope(base);
      const context: ToolContext = {
        ...callbacks,
        jobs: { start: (kind, detail, key) => checked(async () => {
          check();
          if (!base.jobs) throw new AgentError("not_supported", "The host cannot start jobs");
          return sdkJob(await base.jobs.start(kind, structuredClone(detail), key));
        }, "invalid_request") },
        environment: {
          read: path => checked(() => environment().readFile(path)),
          exists: path => checked(() => environment().exists(path)),
          list: path => checked(() => {
            const env = environment();
            if (!env.list) throw new AgentError("not_supported", "The environment does not list directories");
            return env.list(path);
          }),
          write: (path, data) => checked(() => environment().writeFile(path, typeof data === "string" ? data : Buffer.from(data))),
          exec: (command, opts) => checked(() => environment().exec(command, {
            timeoutMs: opts?.timeout, signal: base.signal, onOutput: chunk => base.progress([text(chunk)]),
          })),
        },
        tools: {
          list: () => checked(() => {
            check();
            if (!base.tools) throw new AgentError("not_supported", "The host does not run nested calls");
            return base.tools.list();
          }),
          call: (name, input) => checked(() => {
            check();
            if (!base.tools) throw new AgentError("not_supported", "The host does not run nested calls");
            return base.tools.call(name, input);
          }),
        },
        sessionId: base.sessionId, actorId: call.actorId, callId: call.id, cancelled: base.signal,
        stepId: call.stepId,
        refuse(reason) { check(); throw new Refusal(reason); },
        progress(input) { check(); base.progress(asContent(input)); },
        log(message) { check(); console.error(message); },
        async ask(question, wait) {
          check();
          if (wait && (!Number.isSafeInteger(wait.wait) || wait.wait < 0 || wait.then !== "leaveOpen")) {
            throw new AgentError("invalid_request", "Invalid question wait");
          }
          const answer = await ask(base, wait ? { ...question, timeLimitMs: wait.wait, whenTimeLimit: wait.then } : question);
          check();
          return answer;
        },
      };
      try { return await body.get(tool)!(call.input, context); }
      finally { live = false; finish(); }
    },
  };
}

async function ask(base: BaseContext, question: Parameters<BaseContext["ask"]>[0]): Promise<QuestionReply> {
  try {
    const a = await base.ask({
      ...question, toolCallId: base.call.id,
    });
    return questionReply(question.kind, a);
  } catch (error) {
    if (error instanceof LeftOpen) throw error;
    throw sdkError(error, "invalid_request");
  }
}

export function questionReply(kind: QuestionDraft["kind"], answer: Awaited<ReturnType<BaseContext["ask"]>>): QuestionReply {
  if (answer.pending) throw new LeftOpen("Waiting for an answer");
  if (answer.declined) return { declined: true, reason: answer.reason };
  if (kind === "secret") {
    return answer.stored ? { stored: answer.stored } : { declined: true, reason: "The secret was not stored" };
  }
  return kind === "approval" && answer.value === "allow" ? "allow" : { value: answer.value ?? "" };
}
