import { addAbortListener } from "node:events";
import { definePlugin, tool, type ContentPart, type ImagePart, type ToolContext } from "@modular-agent/core";
import { catalog } from "./catalog.js";
import { bounded, PRINT_BYTES, PrintedOutput, PythonError } from "./codemode-output.js";
import { ValueBuilder, Values } from "./monty-values.js";
import { ComputeBudget, MontyWorker } from "./monty-worker.js";

const description = 'Run Python in a sandbox. The functions listed under "Functions in codemode" in the system prompt are the only way to reach files, commands and other tools. Call them on `tools`, for example `text = tools.read(path="README.md")`. The value of the last expression and anything printed come back as the result. Each run starts fresh: no variables carry over. The sandbox runs a subset of Python: no classes with inheritance, no third-party packages, and no direct file, network or process access.';
const noOs = "the sandbox has no direct access to files, the network, the clock or the environment; use the provided functions";
const isImage = (p: ContentPart): p is ImagePart => p.type === "image";
const note = (content: ContentPart[]) => content.filter(p => p.type === "text").map(p => p.text).join("");
const exception = (excType: string, message: string) => ({ excType, message });
const error = (excType: string, message: string) => new PythonError(exception(excType, message));
const messageOf = (err: unknown) => err instanceof Error ? err.message : String(err);

async function run(code: string, ctx: ToolContext, computeMs: number) {
  const available = catalog(await ctx.tools.list());
  ctx.cancelled.throwIfAborted();
  const tools = new ValueBuilder();
  const pairs = [...available.functions.keys()].map(name => ({ key: tools.add(name), value: tools.node({ function: { name: `tools.${name}` } }) }));
  const module = tools.node({ module: { name: "tools", id: { data: Uint8Array.of(...Array(15).fill(0), 1) }, attrs: { pairs } } });
  const printed = new PrintedOutput(PRINT_BYTES);
  const toText = () => { const text = printed.text(); return text && !text.endsWith("\n") ? `${text}\n` : text; };
  try {
    await using worker = new MontyWorker(ctx.cancelled);
    await worker.configure(computeMs);
    let request: object = { feed: { code, inputs: [{ name: "tools", value: module }], values: tools.values } };
    let calls = 0;
    const budget = new ComputeBudget(computeMs * 1000);
    while (true) {
      const next = await worker.turn(request, budget.remaining, printed);
      if (next.kind === "error" && ["TimeoutError", "MemoryError"].includes(next.error.exception.excType)) throw new PythonError(next.error.exception);
      budget.observe(next.feedExecutionMicros.toNumber());
      if (next.kind === "error") throw new PythonError(next.error.exception);
      if (next.kind === "complete") {
        const { values, value } = next.complete;
        const result = new Values(values);
        const { images, rest, skip } = result.images(value);
        const output = rest ? result.render(value, 50 * 1024, skip) : { text: "", more: false };
        let text = toText();
        for (const image of images) if (typeof image.note === "string") text += `${image.note}\n`;
        text += output.text;
        return { content: [{ type: "text" as const, text: bounded(text || "(no output)", output.more) },
          ...images.map(({ type, mimeType, data }) => ({ type, mimeType, data }))], value: { calls } };
      }
      if (next.kind === "nameLookup") {
        const lookup = next.nameLookup;
        const name = lookup.name;
        if (!lookup.objectId && (name === "describe_tool" || name === "search_tools")) {
          const builder = new ValueBuilder();
          const value = builder.node({ function: { name } });
          request = { resumeNameLookup: { value, values: builder.values } };
        } else request = { resumeNameLookup: { undefined: {} } };
        continue;
      }
      if (next.kind === "osCall") {
        const call = next.osCall;
        const result = call.import?.module === "tools" ? { returnValue: module } : { error: exception("RuntimeError", noOs) };
        const values = "returnValue" in result ? tools.values : undefined;
        request = call.allowEagerAwait
          ? { resumeFutures: { results: [{ callId: call.callId, result }], values } }
          : { resumeCall: { callId: call.callId, result, values } };
        continue;
      }
      if (next.kind !== "functionCall") throw new Error("RuntimeError: awaited something that never resolves");
      const call = next.functionCall;
      const raw = call.functionName;
      const name = raw.replace(/^tools\./, "");
      const fn = raw.startsWith("tools.") ? available.functions.get(name) : undefined;
      try {
        if (call.objectId || (!fn && raw !== "describe_tool" && raw !== "search_tools")) throw error("NameError", `name '${raw}' is not defined`);
        let args, kwargs;
        try { ({ args, kwargs } = new Values(call.values).arguments(call)); }
        catch (err) { throw error("TypeError", `${name}(): ${messageOf(err)}`); }
        let value: unknown;
        if (!fn) {
          const param = raw === "describe_tool" ? "name" : "query";
          const keys = Object.keys(kwargs);
          const key = args[0] ?? kwargs[param];
          if (typeof key !== "string" || args.length + keys.length !== 1 || keys.some(k => k !== param)) throw error("TypeError", `${raw}() takes one string`);
          value = raw === "search_tools" ? available.search(key) : available.functions.get(key)?.describe;
          if (value === undefined) throw error("KeyError", `no function named ${key}`);
        } else {
          let input: Record<string, unknown>;
          try { input = fn.bind(args, kwargs); }
          catch (err) { throw error("TypeError", `${name}(): ${messageOf(err)}`); }
          if (calls === 500) throw error("RuntimeError", "this run made more than 500 function calls");
          calls++;
          // The worker clock is paused during host work. Only a dispatched tool
          // moves the checkpoint, even if the tool fails or is refused.
          budget.dispatchedTool();
          let result;
          try { result = await ctx.tools.call(fn.original, input); }
          catch (err) { throw error("RuntimeError", messageOf(err)); }
          const text = note(result.content);
          if (result.status === "completed") {
            const image = result.content.find(isImage);
            value = result.value !== undefined ? result.value : image ? { ...image, note: text } : text;
          } else {
            const exec = name === "exec" && result.status === "failed" ? result.value as { exit_code?: number; timed_out?: boolean } | undefined : undefined;
            if (exec && typeof exec.exit_code === "number" && exec.exit_code !== 0 && !exec.timed_out) value = exec;
            else throw error("RuntimeError", text);
          }
        }
        ctx.cancelled.throwIfAborted();
        const builder = new ValueBuilder();
        const result = { returnValue: builder.add(value) };
        request = { resumeCall: { callId: call.callId, result, values: builder.values } };
      } catch (err) {
        ctx.cancelled.throwIfAborted();
        const result = { error: err instanceof PythonError ? err.exception : exception("RuntimeError", messageOf(err)) };
        request = { resumeCall: { callId: call.callId, result } };
      }
    }
  } catch (err) {
    ctx.cancelled.throwIfAborted();
    const message = messageOf(err);
    const combined = toText() + message;
    const cut = bounded(combined);
    const reason = err instanceof PythonError ? err.exception.excType : message.split(":", 1)[0];
    const text = message.startsWith("RuntimeError: printed output exceeded")
      ? bounded(`${message}\n${printed.text()}`)
      : cut !== combined && (reason === "MemoryError" || reason === "TimeoutError")
        ? bounded(`${message.split("\n").at(-1)}\n${combined}`)
        : cut;
    return { status: "failed" as const, content: [{ type: "text" as const, text }] };
  }
}

export function codemode({ computeMs = 30_000 } = {}) {
  // Keep the same per-plugin worker cap as the native pool. Queue outside the
  // interpreter clock and remove cancelled calls before they can start a worker.
  let free = 4;
  const waiting = new Set<(granted: boolean) => void>();
  async function acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (free > 0) { free--; return; }
    let ready!: (granted: boolean) => void;
    const slot = new Promise<boolean>(resolve => { ready = resolve; });
    using listener = addAbortListener(signal, () => { if (waiting.delete(ready)) ready(false); });
    waiting.add(ready);
    if (!(await slot)) signal.throwIfAborted();
  }
  return definePlugin({ name: "tools.codemode", tools: [tool({ name: "codemode", description,
    input: { type: "object", properties: { code: { type: "string", description: "Python source to run" } }, required: ["code"], additionalProperties: false },
    inProcessOnly: true, async run({ code }, ctx) {
      await acquire(ctx.cancelled);
      try { return await run(code, ctx, computeMs); }
      finally {
        const next = waiting.values().next().value;
        if (next) { waiting.delete(next); next(true); } else free++;
      }
    } })] });
}
