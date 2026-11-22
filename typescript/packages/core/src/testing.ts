export { overWire } from "./serve.js";
export { restart } from "./agent.js";
import { memoryEnvironment } from "./environment.js";
export { memoryEnvironment, MemoryEnvironment } from "./environment.js";
import { createAgent, type AgentOptions } from "./agent.js";
import type { Answer, Content, ModelError, Question, QuestionHandler, Usage } from "./data.js";
import { AgentError } from "./errors.js";
import type { Provider } from "./provider.js";

export interface ScriptStep {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  error?: ModelError;
  usage?: Partial<Usage>;
}

export function scriptedProvider(script: readonly ScriptStep[]): Provider {
  const steps = structuredClone(script);
  return {
    id: "scripted",
    inProcessInference: true,
    supports: { keepsState: false, safeToRepeat: true },
    models: () => [{ provider: "scripted", id: "script", contextWindow: 128_000, maxOutput: 4096, reasoning: false, input: ["text"] }],
    request(_model, request, context) {
      const index = request.messages.filter(m => m.role === "assistant").length;
      const step = steps[index];
      if (!step || step.error) return { role: "assistant", stop: "failed", content: [],
        error: step?.error ?? { kind: "other", message: "script exhausted" } };
      const content: Content = [];
      if (step.reasoning !== undefined) {
        content.push({ type: "reasoning", text: step.reasoning });
        context.piece("reasoning", step.reasoning);
      }
      if (step.text !== undefined) {
        content.push({ type: "text", text: step.text });
        context.piece("text", step.text);
      }
      for (const [i, call] of (step.toolCalls ?? []).entries()) {
        content.push({ type: "toolCall", id: `call-${index}-${i}`, name: call.name, arguments: structuredClone(call.input) });
      }
      return { role: "assistant", stop: step.toolCalls?.length ? "toolUse" : "finished", content,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...step.usage } };
    },
  };
}
export function testAgent({ script, ...options }: AgentOptions & { script: readonly ScriptStep[] }) {
  return createAgent({ environment: memoryEnvironment(), ...options, providers: [scriptedProvider(script), ...options.providers ?? []],
    model: options.model ?? "scripted/script" });
}

export function answers(list: readonly Answer[]): QuestionHandler & { assertDone(): void } {
  const queue = structuredClone([...list]);
  const unexpected: Question[] = [];
  return Object.assign((question: Question): Answer => {
    if (queue.length) return queue.shift()!;
    unexpected.push(question);
    return "decline";
  }, {
    assertDone() {
      if (queue.length || unexpected.length) {
        throw new AgentError("invalid_request",
          `Unused answers: ${queue.length}; unexpected questions: ${unexpected.map(q => q.question).join(", ") || "none"}`);
      }
    },
  });
}
