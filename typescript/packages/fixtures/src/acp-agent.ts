import { testAgent } from "@modular-agent/core/testing";
const agent = await testAgent({ script: [{ text: "Hi over ACP." }] });
await agent.serveAcp();
