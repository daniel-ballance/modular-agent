import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import protobuf from "protobufjs";
import type { Arguments, Root } from "./monty-values.js";
import { PrintedOutput, type Raised } from "./codemode-output.js";

const require = createRequire(import.meta.url);
const VERSION = "1.6.0";
const PROTOCOL = 8;
const FRAME_LIMIT = 32 * 1024 * 1024;
const OPEN_MS = 5000;
// Allow the worker to report its own TimeoutError before killing a stuck turn.
const GRACE_MS = 250;
const timeoutError = () => new Error("TimeoutError: sandbox time limit exceeded");

// Worker events carry cumulative active wall time, not time spent on the host.
export class ComputeBudget {
  private active = 0;
  private checkpoint = 0;
  constructor(private readonly limit: number) {}
  get remaining() { return this.limit - (this.active - this.checkpoint); }
  observe(micros: number) {
    if (micros < this.active) throw new Error("Monty execution clock went backwards");
    this.active = micros;
    if (this.remaining <= 0) throw timeoutError();
  }
  dispatchedTool() { this.checkpoint = this.active; }
}

interface Call { callId: number; allowEagerAwait?: boolean }
interface Event {
  kind: string;
  feedExecutionMicros: { toNumber(): number };
  executionClock: number;
  print: { segments: { text: string }[] };
  error: { exception: Raised };
  fatalError: { message: string };
  sessionRefused: { message: string };
  complete: Root;
  nameLookup: { name: string; objectId?: object };
  functionCall: Call & Arguments & { functionName: string; objectId?: object };
  osCall: Call & { import?: { module: string } };
}

let codecs: { request: protobuf.Type; event: protobuf.Type } | undefined;
function protocol() {
  if (codecs) return codecs;
  const schema = readFileSync(new URL("../../vendor/monty/monty.proto", import.meta.url), "utf8");
  const { root } = protobuf.parse(schema);
  root.resolveAll();
  return codecs = { request: root.lookupType("monty.v1.ClientRequest"), event: root.lookupType("monty.v1.WorkerEvent") };
}

function workerPath() {
  const platform = process.platform;
  const suffix = platform === "linux" ? "-gnu" : platform === "win32" ? "-msvc" : "";
  const pkg = `@pydantic/monty-${platform}-${process.arch}${suffix}`;
  const manifest = require.resolve(`${pkg}/package.json`, { paths: [dirname(require.resolve("@pydantic/monty"))] });
  if (require(manifest).version !== VERSION) throw new Error(`Expected Monty worker ${VERSION}`);
  return join(dirname(manifest), process.platform === "win32" ? "monty.exe" : "monty");
}

// Check the size before decoding. A short protobuf frame can still describe
// millions of empty objects or packed indexes, so bound those allocations too.
function decode(type: protobuf.Type, body: Buffer) {
  const reader = protobuf.Reader.create(body);
  let budget = 64 * 1024 * 1024;
  function scan(message: protobuf.Type, end: number, depth: number) {
    if (depth > 32) throw new Error("Monty frame is too deeply nested");
    while (reader.pos < end) {
      const tag = reader.uint32(), wire = tag & 7;
      const field = message.fieldsById[tag >>> 3];
      if (!field || wire === 3 || wire === 4) throw new Error("invalid Monty frame field");
      budget -= 64;
      if (wire === 2) {
        const size = reader.uint32(), stop = reader.pos + size;
        if (stop > end) throw new Error("invalid Monty field length");
        if (field.resolvedType instanceof protobuf.Type) scan(field.resolvedType, stop, depth + 1);
        else {
          if (field.repeated && field.packed) budget -= 16 * size;
          reader.skip(size);
        }
      } else reader.skipType(wire);
      if (budget < 0) throw new Error("Monty frame exceeds decode budget");
    }
    if (reader.pos !== end) throw new Error("invalid Monty frame length");
  }
  scan(type, body.length, 0);
  return type.decode(body) as unknown as Event;
}

export class MontyWorker {
  private readonly child = spawn(workerPath(), ["subprocess"], { env: {}, stdio: ["pipe", "pipe", "ignore"] });
  private readonly stream = this.child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  private readonly closed: Promise<void>;
  private readonly abort: Disposable;
  private chunk: Buffer = Buffer.alloc(0);
  private failure?: Error;
  private timedOut = false;

  constructor(private readonly signal: AbortSignal) {
    this.closed = new Promise(resolve => this.child.once("close", () => resolve()));
    this.child.on("error", err => { this.failure ??= err; });
    this.child.stdin.on("error", err => { this.failure ??= err; });
    this.abort = addAbortListener(signal, () => this.kill());
  }

  private kill() { this.child.kill("SIGKILL"); }
  async [Symbol.asyncDispose]() {
    this.abort[Symbol.dispose]();
    this.kill();
    this.child.stdout.destroy();
    this.child.stdin.destroy();
    await this.closed;
  }

  private async read(size: number) {
    if (this.chunk.length >= size) {
      const bytes = this.chunk.subarray(0, size);
      this.chunk = this.chunk.subarray(size);
      return bytes;
    }
    const bytes = Buffer.allocUnsafe(size);
    let filled = 0;
    while (filled < size) {
      if (!this.chunk.length) {
        const next = await this.stream.next();
        if (next.done) {
          await this.closed;
          if (this.timedOut) throw timeoutError();
          if (this.child.exitCode === 65) throw new Error("MemoryError: sandbox worker exceeded its memory limit");
          throw new Error(`The sandbox worker process died${this.failure ? `: ${this.failure.message}` : ""}`);
        }
        this.chunk = next.value;
      }
      const copied = this.chunk.copy(bytes, filled, 0, size - filled);
      filled += copied;
      this.chunk = this.chunk.subarray(copied);
    }
    return bytes;
  }

  async configure(computeMs: number) {
    const event = await this.exchange({ configure: { scriptName: "main.py", protocolVersion: PROTOCOL, montyVersion: VERSION, executionClock: 0,
      limits: { maxTurnDurationMicros: computeMs * 1000, maxMemoryBytes: 256 * 1024 * 1024, maxRecursionDepth: 200 },
      osPolicy: { callHost: {}, sleep: { callHost: {} }, randomCallHost: {}, zero: {} } } }, OPEN_MS);
    if (event.kind !== "ok" || !Object.hasOwn(event, "executionClock") || event.executionClock !== 0) throw new Error("Monty did not acknowledge the wall clock configuration");
  }

  turn(request: object, remainingMicros: number, printed: PrintedOutput) {
    return this.exchange(request, Math.ceil(remainingMicros / 1000) + GRACE_MS, printed);
  }

  private async exchange(request: object, timeoutMs: number, printed?: PrintedOutput) {
    this.signal.throwIfAborted();
    const { request: req, event: evt } = protocol();
    const body = req.encode(request).finish();
    if (!body.length || body.length > FRAME_LIMIT) throw new Error("Monty request exceeds its frame limit");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    const timer = setTimeout(() => { this.timedOut = true; this.kill(); }, timeoutMs);
    try {
      this.child.stdin.write(header);
      this.child.stdin.write(body);
      while (true) {
        const size = (await this.read(4)).readUInt32LE();
        if (!size || size > FRAME_LIMIT) throw new Error("Monty response exceeds its frame limit");
        const payload = await this.read(size);
        this.signal.throwIfAborted();
        if (this.timedOut) throw timeoutError();
        const event = decode(evt, payload);
        if (event.kind === "fatalError" || event.kind === "sessionRefused") throw new Error(`Monty worker: ${event[event.kind].message}`);
        if (event.kind !== "print") return event;
        if (!printed) throw new Error("unexpected Monty print event");
        for (const segment of event.print.segments) printed.append(segment.text);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
