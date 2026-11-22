import { spawn } from "node:child_process";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { wireTap } from "./wire.mjs";

const [wire, executable, ...args] = process.argv.slice(2);
if (!wire || !executable) throw new Error("Usage: wire-proxy.mjs WIRE EXECUTABLE [ARG ...]");
const child = spawn(executable, args, { stdio: ["pipe", "pipe", "inherit"] });
const closed = once(child, "close");
const outgoing = pipeline(child.stdout, wireTap(wire, "pluginToHost"), process.stdout, { end: false });
// The host can keep its pipe open while waiting for plugin/shutdown to finish.
const input = wireTap(wire, "hostToPlugin");
const incomingFailure = new Promise((_, reject) => {
  process.stdin.once("error", reject);
  input.once("error", reject);
  child.stdin.on("error", error => {
    if (error.code !== "EPIPE") reject(error);
  });
});
process.stdin.pipe(input).pipe(child.stdin);
const terminate = () => child.kill("SIGTERM");
process.once("SIGTERM", terminate);
try {
  const [[code, signal]] = await Promise.race([Promise.all([closed, outgoing]), incomingFailure]);
  if (code !== 0) throw new Error(`Fixture exited with ${signal ?? code}`);
} finally {
  process.stdin.destroy();
  child.kill();
  process.removeListener("SIGTERM", terminate);
}
