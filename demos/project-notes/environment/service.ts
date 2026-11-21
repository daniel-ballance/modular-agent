import { localEnvironment, serve } from "@modular-agent/core";

const [project, tokenFile] = process.argv.slice(2);
if (!project || !tokenFile) throw new Error("Usage: node dist/service.js PROJECT TOKEN_FILE");

const server = await serve({
  name: "notes-environment",
  replaces: ["working-environment"],
  setup(registrar) {
    registrar.environment(localEnvironment(project));
  },
}, { listen: "127.0.0.1:0", tokenFile });

process.once("SIGTERM", () => void server.close().catch(() => {
  console.error("Could not close the environment service.");
  process.exitCode = 1;
}));
console.log(server.url);
