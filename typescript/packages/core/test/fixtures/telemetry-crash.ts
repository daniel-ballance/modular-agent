import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { fileHistory, tool } from "../../src/index.js";
import { testAgent } from "../../src/testing.js";

const dir = process.argv[2];
trace.setGlobalTracerProvider(new TracerProvider());
const agent = await testAgent({ project: dir, dataDir: dir, durability: "durable", history: fileHistory(join(dir, "history")),
  script: [{ toolCalls: [{ name: "barrier", input: {} }] }],
  tools: [tool({ name: "barrier", description: "Signal after dispatch", input: { type: "object" }, async run() {
    await writeFile(join(dir, "effect"), "once", { flag: "wx" });
    const start = (await session.history()).find(entry => entry.kind === "turnStart")!;
    process.send!({ sessionId: session.id, turnId: start.turnId, traceContext: (start.data as { traceContext: unknown }).traceContext });
    return new Promise<string>(() => {});
  } })],
});
const session = await agent.session();
// Keep the fixture alive while the parent reads the committed record and kills it.
process.on("message", () => {});
await session.prompt("crash prompt sentinel");
