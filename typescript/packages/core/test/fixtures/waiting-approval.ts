import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgent, definePlugin, tool, type AgentOptions } from "../../src/index.js";
import { memoryEnvironment, scriptedProvider } from "../../src/testing.js";
import { remoteRuntime } from "./interface-tools.js";

export const reviewer = { id: "reviewer", kind: "user" as const, rights: ["watch", "approve"] as ("watch" | "approve")[] };
export const amount = { amount: 1 };
export function waitingAgent(dataDir: string, remote: boolean, options: AgentOptions = {}, atEffect?: () => Promise<void>, source = "counter", description = "Increment", readOnly = false) {
  const bump = tool({ name: "bump", description, readOnly, input: { type: "object" }, async run() {
    await appendFile(join(dataDir, "count"), "1"); await atEffect?.(); return "Incremented";
  } });
  return createAgent({ dataDir, durability: "kept", environment: memoryEnvironment(), approval: "all", maxApprovalWaitMs: 60_000,
    questionsOutlastTurns: true, severalActors: true, settings: { approvalWait: "untilDeadline" },
    providers: [scriptedProvider([{ toolCalls: [{ name: "bump", input: amount }] }, { text: "Done" }])],
    ...(remote ? { processPlugins: [remoteRuntime(options.durability === "durable")] } : {}), ...options,
    plugins: [definePlugin({ name: source, tools: [bump] }), ...options.plugins ?? []] });
}

if (process.send && process.argv[2] === "approval-crash") {
  const [, , , dir, placement, cutoff, durability] = process.argv;
  let id: string, callId: string, questionId: string, deadline: number;
  const stop = async () => {
    process.send!({ id, callId, questionId, deadline });
    await new Promise<void>(() => {});
  };
  let turns = 0;
  const barrier = definePlugin({ name: "cutoff", hooks: { "turn.before": async () => {
    if (++turns === 2 && cutoff === "allowed") await stop();
  } } });
  const agent = await waitingAgent(dir, placement === "served", { durability: durability as "kept" | "durable", plugins: [barrier] }, cutoff === "effect" ? stop : undefined);
  const session = await agent.session({ actors: [reviewer] });
  id = session.id;
  [callId] = (await session.prompt("Increment")).openToolCalls;
  const handle = session.as(reviewer.id);
  const [q] = await handle.questions({ present: true });
  questionId = q.id; deadline = q.deadline!;
  if (cutoff === "waiting") await stop();
  await handle.answer(questionId, "allow");
  await session.waitIdle();
}
