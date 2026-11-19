import { testAgent } from "@modular-agent/core/testing";
import { fixture } from "./index.js";

const dataDir = process.argv[2];
const agent = await testAgent(dataDir ? {
  pluginHost: true, dataDir, durability: "durable", plugins: [fixture("confirm")],
  script: [
    { toolCalls: [{ name: "hold", input: {} }] },
    { toolCalls: [{ name: "confirm", input: { question: "Recover?" } }] },
    { text: "Recovery finished." }, { text: "Fresh turn." },
  ],
} : { pluginHost: true, script: [{ text: "Hi over ACP." }] });
await agent.serveAcp();
