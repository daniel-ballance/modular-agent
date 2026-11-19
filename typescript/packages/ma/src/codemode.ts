import { ExternalModule, FunctionSnapshot, Monty, MontyComplete, MontyRuntimeError, MontySyntaxError, NameLookupSnapshot } from "@pydantic/monty";
import { definePlugin, tool, type ContentPart, type ImagePart, type ToolContext } from "@modular-agent/core";
import { catalog } from "./catalog.js";

const description = 'Run Python in a sandbox. The functions listed under "Functions in codemode" in the system prompt are the only way to reach files, commands and other tools. Call them on `tools`, for example `text = tools.read(path="README.md")`. The value of the last expression and anything printed come back as the result. Each run starts fresh: no variables carry over. The sandbox runs a subset of Python: no classes with inheritance, no third-party packages, and no direct file, network or process access.';
const noOs = "the sandbox has no direct access to files, the network, the clock or the environment; use the provided functions";
const utf8 = Buffer.byteLength;
const CAP = 1024 * 1024;
function bounded(text: string) {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= 2000 && utf8(text) <= 51200) return text;
  let kept = "", count = 0;
  for (const line of lines.slice(0, 2000)) {
    if (utf8(kept) + utf8(line) + 1 > 51200) break;
    kept += line + "\n";
    count++;
  }
  return `${kept}\n[Output cut: showing the first ${count} of ${lines.length} lines (${utf8(kept)} of ${utf8(text)} bytes). Return or print less, or write the rest to a file.]`;
}
const isImage = (v: unknown): v is ImagePart => !!v && typeof v === "object" && "type" in v && v.type === "image" && "mimeType" in v && typeof v.mimeType === "string" && "data" in v && typeof v.data === "string";
const note = (content: ContentPart[]) => content.filter(p => p.type === "text").map(p => p.text).join("");
type PythonJson = null | boolean | number | string | PythonJson[] | { [name: string]: PythonJson };
function pythonJson(value: unknown): PythonJson {
  if (value == null) return null;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(pythonJson);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, val]) => [String(key), pythonJson(val)]));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, pythonJson(val)]));
  return String(value);
}

async function run(pool: Monty, code: string, ctx: ToolContext) {
  const available = catalog(await ctx.tools.list());
  const modules = Object.fromEntries([...available.functions.keys()].map(name => [name, () => {}]));
  // The SDK counts nested tool calls below. Monty's suspension counter also
  // includes lookups and must not cut off a run before its 500th tool call.
  await using sandbox = await pool.checkout({ scriptName: "main.py", limits: { maxTurnDurationSecs: 30, maxRecursionDepth: 200,
    maxMemory: 32 * 1024 * 1024, maxSuspensions: Number.MAX_SAFE_INTEGER },
    externalModules: { tools: new ExternalModule(modules) }, osPolicy: { datetime: "call_host", sleep: "call_host", randomStart: "call_host" } });
  let printed = "", bytes = 0, over = false, calls = 0;
  const error = (kind: string, message: string) => new MontyRuntimeError(kind, message);
  const toText = () => printed && !printed.endsWith("\n") ? printed + "\n" : printed;
  try {
    await sandbox.feedRun("import tools");
    let next = await sandbox.feedStart(code, { printCallback(_stream, text) {
      if (over) return;
      if (bytes + utf8(text) > CAP) { over = true; return; }
      bytes += utf8(text); printed += text;
    } });
    while (!(next instanceof MontyComplete)) {
      ctx.cancelled.throwIfAborted();
      if (over) throw error("RuntimeError", "printed output exceeded 1048576 bytes");
      if (next instanceof NameLookupSnapshot) {
        next = await next.resume(["describe_tool", "search_tools"].includes(next.variableName) ? next.variableName : undefined);
        continue;
      }
      if (!(next instanceof FunctionSnapshot)) throw error("RuntimeError", "awaited something that never resolves");
      if (next.isOsFunction) {
        next = next.functionName === "import" && next.args[0] === "tools" ? await next.resumeAuto() : await next.resumeError(error("RuntimeError", noOs));
        continue;
      }
      const { functionName: raw, args, kwargs } = next;
      const name = raw.replace(/^tools\./, "");
      let value: unknown;
      try {
        if (raw === "describe_tool" || raw === "search_tools") {
          const key = args[0] ?? kwargs[raw === "describe_tool" ? "name" : "query"];
          if (typeof key !== "string") throw error("TypeError", `${raw}() takes one string`);
          if (raw === "search_tools") value = available.search(key);
          else {
            value = available.functions.get(key)?.describe;
            if (!value) throw error("KeyError", `no function named ${key}`);
          }
        } else {
          const fn = available.functions.get(name);
          if (!raw.startsWith("tools.") || !fn) throw error("NameError", `name '${raw}' is not defined`);
          let input: Record<string, unknown>;
          try { input = fn.bind(args.map(pythonJson), Object.fromEntries(Object.entries(kwargs).map(([k, v]) => [k, pythonJson(v)]))); }
          catch (err) { throw error("TypeError", `${name}(): ${(err as Error).message}`); }
          if (++calls > 500) throw error("RuntimeError", "this run made more than 500 function calls");
          let result;
          try { result = await ctx.tools.call(fn.original, input); }
          catch (err) { throw error("RuntimeError", `${name}() could not run: ${(err as Error).message}`); }
          const text = note(result.content);
          if (result.status === "completed") {
            const image = result.content.find(isImage);
            value = result.value !== undefined ? result.value : image ? { ...image, note: text } : text;
          } else if (name === "exec" && result.status === "failed" && result.value && typeof result.value === "object" && !(result.value as { timed_out?: boolean }).timed_out) value = result.value;
          else throw error("RuntimeError", `${name}() ${result.status === "outcomeUnknown" ? "outcome unknown" : result.status}: ${text}`);
        }
      } catch (err) { next = await next.resumeError(err); continue; }
      next = await next.resume(value);
    }
    if (over) throw error("RuntimeError", "printed output exceeded 1048576 bytes");
    const output: unknown = pythonJson(next.output);
    const images = (Array.isArray(output) ? output : [output]).filter(isImage);
    const rest = Array.isArray(output) ? output.filter(x => !isImage(x)) : isImage(output) ? null : output;
    let text = toText();
    for (const image of images) if (typeof image.note === "string") text += `${image.note}\n`;
    if (rest != null && !(images.length && Array.isArray(rest) && !rest.length)) text += typeof rest === "string" ? rest : JSON.stringify(rest, null, 2);
    return { content: [{ type: "text", text: bounded(text || "(no output)") }, ...images.map(({ type, mimeType, data }) => ({ type, mimeType, data }))], value: { calls } };
  } catch (err) {
    const message = err instanceof MontyRuntimeError || err instanceof MontySyntaxError ? err.display("traceback") : (err as Error).message;
    const text = over ? `RuntimeError: printed output exceeded ${CAP} bytes\n${bounded(printed).trimEnd()}`.trimEnd() : bounded(toText() + message);
    return { status: "failed" as const, content: [{ type: "text", text }] };
  }
}

export function codemode() {
  let pool: Promise<Monty> | undefined;
  return definePlugin({ name: "tools.codemode", tools: [tool({ name: "codemode", description,
    input: { type: "object", properties: { code: { type: "string", description: "Python source to run" } }, required: ["code"], additionalProperties: false },
    inProcessOnly: true, async run({ code }, ctx) {
      pool ??= Monty.create({ requestTimeout: 32, maxProcesses: 4, maxCheckoutsPerWorker: 1 });
      return run(await pool, code, ctx);
    } })], async stop() { if (pool) await (await pool).close(); } });
}
