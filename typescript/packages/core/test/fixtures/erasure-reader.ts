import { parentPort, workerData } from "node:worker_threads";
import { filePendingErasure } from "@modular-agent/harness";

const { dir, state } = workerData as {
  dir: string;
  state: Int32Array<SharedArrayBuffer>;
};
const registry = filePendingErasure(dir);
registry.intents();
Atomics.store(state, 1, 1);
Atomics.notify(state, 1);
Atomics.wait(state, 0, 0);
Atomics.store(state, 1, 2);
Atomics.notify(state, 1);
try {
  parentPort!.postMessage({ ok: true, intents: registry.intents() });
} catch (error) {
  const err = error as Error & { code?: string; cause?: { errcode?: number } };
  parentPort!.postMessage({ ok: false, code: err.code, errcode: err.cause?.errcode, message: err.message });
} finally {
  Atomics.store(state, 1, 3);
  Atomics.notify(state, 1);
}
