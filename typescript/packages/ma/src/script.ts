import { appendFile, readFile } from "node:fs/promises";
import { scriptedProvider, type ScriptStep } from "@modular-agent/core/testing";
import { definePlugin, tool, type ContentPart, type Provider } from "@modular-agent/core";

export function scriptTestTools() {
  return definePlugin({
    name: "standard.script-tools",
    tools: [
      tool({
        name: "test_ask_secret",
        description: "Ask a secret question for scripted testing.",
        input: {
          type: "object",
          properties: {
            question: { type: "string" },
            credential: { type: "string" },
          },
          required: ["question", "credential"],
          additionalProperties: false,
        },
        async run(input, cx) {
          const { question, credential, ...extra } = input as Record<string, unknown>;
          if (typeof question !== "string" || typeof credential !== "string" || Object.keys(extra).length > 0) {
            throw new Error("test_ask_secret requires only string question and credential");
          }
          const answer = await cx.ask({ kind: "secret", question, credential });
          return typeof answer === "object" && "stored" in answer ? "stored" : "declined";
        },
      }),
    ],
  });
}

export async function loadScript(file?: string, log?: string): Promise<Provider | undefined> {
  if (!file) return;
  const script = JSON.parse(await readFile(file, "utf8")) as ScriptStep[];
  if (!Array.isArray(script)) throw new Error("the model script must be an array");
  const provider = scriptedProvider(script);
  const text = (content: ContentPart[]) => content.filter(p => p.type === "text").map(p => p.text).join("");
  return { ...provider, async request(model, request, ctx) {
    if (log) await appendFile(log, JSON.stringify({ system: request.systemPrompt, tools: request.tools.map(t => t.name), messages: request.messages.map(m => {
      const common = { role: m.role, text: text(m.content) };
      return m.role === "assistant" ? { ...common, toolCalls: m.content.filter(p => p.type === "toolCall").map(p => ({ name: p.name, input: p.arguments })) }
        : m.role === "toolResult" ? { ...common, name: m.toolName } : common;
    }) }) + "\n");
    return provider.request(model, request, ctx);
  } };
}
