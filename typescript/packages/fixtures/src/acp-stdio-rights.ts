import { testAgent } from "@modular-agent/core/testing";

const dataDir = process.env.MODULAR_AGENT_DATA_DIR;
if (process.env.MODULAR_AGENT_CONFORMANCE !== "1" || !dataDir) {
  throw new Error("acp-stdio-rights requires a disposable conformance directory");
}
const raw = process.env.MA_ACP_STDIO_RIGHTS;
const agent = await testAgent({ dataDir, durability: "kept", script: [{ text: "First turn." }, { text: "Second turn." }] });
await agent.serveAcp({
  actor: { id: "rights-fixture", kind: "host", rights: ["watch", "input", "settings"] },
  rights: raw === undefined ? undefined : JSON.parse(raw),
});
