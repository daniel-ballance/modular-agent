import { createAgent, type AgentOptions, type Actor, type ToolDefinition } from "../../src/index.js";
import { memoryEnvironment, scriptedProvider } from "../../src/testing.js";

export const picker: Actor = { id: "picker", kind: "user", rights: ["watch", "tools"] };
export const pick: ToolDefinition = { name: "pick_color", description: "Pick a color", parameters: { type: "object" },
  returns: { type: "string" }, callers: ["model"] };
export const source = { sourceId: "colors", actorId: picker.id, routeId: "palette", resultTimeoutMs: 60_000, tools: [pick] };
export const requested = { toolCalls: [{ name: pick.name, input: { palette: "ARGUMENT_MARKER" } }] };
export const provider = () => scriptedProvider([requested, { text: "Continued." }, { text: "Next." }]);
export const remoteRuntime = (durable = false) => ({ command: [process.execPath, "--input-type=module", "-e", `
  import {servePlugins} from '@modular-agent/plugin-wire';
  import {${durable ? "durableRuntime" : "transientRuntime"} as runtime} from '@modular-agent/runtime-${durable ? "durable" : "transient"}';
  await servePlugins({name:'interface-runtime',plugins:[runtime()],replaces:['runtime']});
`] });

if (process.send && process.argv[2] === "crash") {
  const [, , , dir, placement, cutoff, durability] = process.argv;
  const options: AgentOptions = { dataDir: dir, durability: durability as "kept" | "durable", environment: memoryEnvironment(),
    severalActors: true, interfaceTools: [source], providers: [provider()], settings: { maxSteps: 5 },
    ...(placement === "remote" ? { processPlugins: [remoteRuntime(durability === "durable")] } : {}) };
  const agent = await createAgent(options);
  const session = await agent.session({ actors: [picker] });
  const transport = agent.connectInterfaceTools(session.id, { actor: picker, routeId: source.routeId,
    onHandoff(handoff) {
      if (cutoff === "handoff") {
        // The callback is entered only after the start/checkpoint append. Stop here,
        // before returning pending or allowing the Runtime to finish the turn.
        process.send!({ id: session.id, callId: handoff.call.id });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    } });
  transport.advertise([pick]);
  const result = await session.prompt("Pick a color.");
  process.send({ id: session.id, callId: result.openToolCalls[0] });
  await new Promise(() => {});
}
