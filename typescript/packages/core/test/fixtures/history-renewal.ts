import { parentPort, workerData } from "node:worker_threads";
import { historyService } from "@modular-agent/services";

const { token, dir, ttlMs, controls } = workerData as {
  token: string; dir: string; ttlMs: number; controls: Parameters<typeof historyService>[1];
};
const service = await historyService({ token, dir, leaseTtl: ttlMs }, controls);
parentPort!.postMessage(service.url);
parentPort!.once("message", () => service.server.close());
