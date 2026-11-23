import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultAcpActor, tool } from "@modular-agent/core";
import { testAgent } from "@modular-agent/core/testing";

const [project, dataDir] = process.argv.slice(2);
const agent = await testAgent({project, dataDir, durability:"durable", severalActors:true,
  script:[{ toolCalls:[{name:"mark", input:{}}] }],
  tools:[tool({name:"mark", description:"Mark dispatch", input:{type:"object"}, async run() {
    await appendFile(join(project, "effect"), "once\n");
    process.send!({sessionId:session.id});
    await new Promise<void>(() => {});
  }})]});
const session = await agent.session({actors:[defaultAcpActor()]});
process.on("message", () => {}); // Keep the writer until the parent kills the process.
await session.prompt("private crash prompt");
