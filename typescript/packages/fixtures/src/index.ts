import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentError, definePlugin, tool, type Plugin } from "@modular-agent/core";
import { textOf } from "@modular-agent/harness";
import { z } from "zod";

export const tide = tool({
  name: "tide",
  description: "Today's high tide at a harbour.",
  input: z.object({ harbour: z.string().describe("The harbour to look up.") }),
  readOnly: true,
  run: async ({ harbour }) => `High tide at ${harbour} is 14:02.`,
});

export function count(path: string): number {
  try { return Number(readFileSync(path, "utf8").trim()) || 0; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export function fixture(name: string, config?: Record<string, unknown>): Plugin {
  switch (name) {
    case "tide": return definePlugin({ name, config, tools: [tide] });
    case "counter": return definePlugin({ name, config, setup(r) {
      const { path } = r.config();
      if (typeof path !== "string" || !isAbsolute(path)) throw new AgentError("invalid_params", "counter needs an absolute config path");
      r.tool(tool({
        name: "bump", description: "Add one to a count kept in a file.",
        input: z.object({ hold: z.boolean().optional().describe("Wait after counting until cancelled, so a crash lands after the effect."), note: z.string().optional() }),
        async run({ hold }, cx) {
          const next = count(path) + 1;
          writeFileSync(path + ".tmp", String(next));
          renameSync(path + ".tmp", path);
          if (hold) await delay(2 ** 31 - 1, undefined, { signal: cx.cancelled });
          return String(next);
        },
      }));
    } });
    case "confirm": return definePlugin({ name, config, tools: [tool({
      name: "confirm", description: "Ask whether to go ahead.",
      input: z.object({ question: z.string() }),
      async run({ question }, cx) {
        const answer = await cx.ask({ kind: "choice", question, options: ["yes", "no"] });
        return typeof answer === "object" && "value" in answer ? answer.value : "declined";
      },
    })] });
    case "gate": return definePlugin({ name, config, hooks: {
      "tool.before": ({ call }) => JSON.stringify(call.input).includes("forbidden") ? { refuse: "the gate refused it" } : "allow",
    } });
    case "quay": return definePlugin({ name, config, tools: [tool({
      name: "moor", description: "Moor at a harbour.",
      input: z.object({ harbour: z.string() }),
      run(_input, cx) { cx.refuse("the quay is closed"); },
    })] });
    case "pilot": return definePlugin({ name, config, tools: [tool({
      name: "pilot", description: "Ask the pilot about a harbour's tide.",
      input: z.object({ harbour: z.string() }),
      async run(input, cx) {
        const result = await cx.tools.call("tide", input);
        return `Pilot: ${textOf(result.content)}`;
      },
    })] });
    default: throw new AgentError("not_found", `No fixture named ${name}`);
  }
}
