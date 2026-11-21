import { utf8Prefix } from "./codemode-output.js";

interface Pair { key: number; value: number }
interface Indexes { items: number[] }
interface DateFields { year: number; month: number; day: number }
interface TimeFields { hour: number; minute: number; second: number; microsecond: number; offsetSeconds?: number; timezoneName?: string; fold?: number }
interface Zone { offsetSeconds: number; name?: string }
interface Node {
  kind: keyof Omit<Node, "kind">;
  none: object; ellipsis: object; notImplemented: object; boolean: boolean; int: { toString(): string };
  bigint: { negative: boolean; magnitude: Uint8Array }; float: number; str: string; bytes: Uint8Array;
  list: Indexes; tuple: Indexes; set: Indexes; frozenSet: Indexes; dict: { pairs: Pair[] };
  namedTuple: { values: number[]; fieldNames: string[]; typeName: string };
  complex: { real: number; imag: number }; date: DateFields; time: TimeFields; datetime: DateFields & TimeFields;
  timedelta: { days: number; seconds: number; microseconds: number }; timezone: Zone;
  exception: { excType: string; arg?: string }; decimal: string; path: string; repr: string; cycle: string;
  classInstance: { classType: number; attrs: { pairs: Pair[] } }; type: { name: string };
  function: { name: string }; builtinFunction: string; module: { name: string };
}
export interface Arena { nodes: Node[]; nodeCount: number }
export interface Root { values: Arena; value: number }
export interface Arguments { values?: Arena; args: number[]; kwargs: Pair[] }

export class Values {
  private readonly nodes: Node[];
  private readonly eligible = new Map<number, boolean>();
  constructor(arena?: Arena) {
    this.nodes = arena?.nodes ?? [];
    if (arena && arena.nodeCount !== this.nodes.length) throw new Error("invalid Monty value arena");
  }
  private node(id: number) {
    const node = this.nodes[id];
    if (!node?.kind) throw new Error("invalid Monty value reference");
    return node;
  }
  private children(id: number, ids: number[]) {
    if (ids.some(i => i >= id || i < 0)) throw new Error("invalid Monty child reference");
    return ids;
  }
  private pairs(id: number, pairs: Pair[]) {
    for (const p of pairs) if (p.key >= id || p.value >= id || p.key < 0 || p.value < 0) throw new Error("invalid Monty dict reference");
    return pairs;
  }
  private integer(n: Node) {
    if (n.kind === "int") return n.int.toString();
    const { magnitude, negative } = n.bigint;
    return (negative ? "-" : "") + BigInt(`0x${Buffer.from(magnitude).toString("hex") || "0"}`).toString();
  }
  private key(id: number) {
    const n = this.node(id);
    switch (n.kind) {
      case "str": return n.str;
      case "int": case "bigint": return this.integer(n);
      case "float": return Number.isFinite(n.float) ? float(n.float) : undefined;
      case "none": return "null";
      case "boolean": return n.boolean ? "true" : "false";
    }
  }
  private json(id: number, depth = 0): boolean {
    if (depth > 400) throw new Error("Monty result is too deeply nested");
    const prior = this.eligible.get(id);
    if (prior !== undefined) return prior;
    const n = this.node(id);
    let ok: boolean;
    switch (n.kind) {
      case "list": case "tuple": ok = this.children(id, n[n.kind].items).every(i => this.json(i, depth + 1)); break;
      case "namedTuple": ok = this.children(id, n.namedTuple.values).every(i => this.json(i, depth + 1)); break;
      case "dict": ok = this.pairs(id, n.dict.pairs).every(p => this.key(p.key) !== undefined && this.json(p.value, depth + 1)); break;
      default: ok = this.key(id) !== undefined;
    }
    this.eligible.set(id, ok);
    return ok;
  }
  // Stop expanding shared containers once the result text is full.
  render(id: number, maxBytes: number, without: ReadonlySet<number> = new Set()) {
    const n = this.node(id);
    if (n.kind === "none") return { text: "", more: false };
    const pieces = n.kind === "str" ? [n.str] : this.pieces(id, this.json(id), 0, without);
    let remaining = maxBytes;
    const chunks: string[] = [];
    for (const piece of pieces) {
      const size = Buffer.byteLength(piece);
      if (size > remaining) return { text: chunks.join("") + utf8Prefix(Buffer.from(piece), remaining), more: true };
      remaining -= size;
      if (size) chunks.push(piece);
    }
    return { text: chunks.join(""), more: false };
  }
  private *pieces(id: number, json: boolean, depth: number, without: ReadonlySet<number>): Generator<string> {
    if (depth > 400) throw new Error("Monty result is too deeply nested");
    const n = this.node(id);
    const child = (i: number) => this.pieces(i, json, depth + 1, without);
    const line = (depth: number) => "\n" + "  ".repeat(depth);
    let open: string, close: string, entries: Iterable<Iterable<string>>, tuple = false;
    const mapped = function* <T>(items: Iterable<T>, fn: (item: T, index: number) => Iterable<string>) {
      let i = 0;
      for (const item of items) yield fn(item, i++);
    };
    switch (n.kind) {
      case "list": case "tuple": case "namedTuple": case "set": case "frozenSet": {
        let ids = this.children(id, n.kind === "namedTuple" ? n.namedTuple.values : n[n.kind].items);
        if (depth === 0 && without.size) ids = ids.filter(i => !without.has(i));
        [open, close] = json || n.kind === "list" ? ["[", "]"] : n.kind === "set" ? (ids.length ? ["{", "}"] : ["set(", ")"])
          : n.kind === "frozenSet" ? (ids.length ? ["frozenset({", "})"] : ["frozenset(", ")"])
          : n.kind === "namedTuple" ? [`${n.namedTuple.typeName}(`, ")"] : ["(", ")"];
        tuple = !json && n.kind === "tuple" && ids.length === 1;
        entries = mapped(ids, function* (item, i) {
          if (n.kind === "namedTuple" && !json) yield `${n.namedTuple.fieldNames[i]}=`;
          yield* child(item);
        });
        break;
      }
      case "dict": case "classInstance": {
        const instance = n.kind === "classInstance";
        [open, close] = instance ? [`${this.node(n.classInstance.classType).type.name}(`, ")"] : ["{", "}"];
        const key = (i: number) => json ? JSON.stringify(this.key(i)) : instance ? this.node(i).str : undefined;
        entries = mapped(this.pairs(id, instance ? n.classInstance.attrs.pairs : n.dict.pairs), function* (pair) {
          const name = key(pair.key);
          if (name !== undefined && name !== null) yield name; else yield* child(pair.key);
          yield instance ? "=" : ": ";
          yield* child(pair.value);
        });
        break;
      }
      default: yield this.leaf(n, json); return;
    }
    yield open;
    let count = 0;
    for (const entry of entries) {
      if (count++) yield json ? "," : ", ";
      if (json) yield line(depth + 1);
      yield* entry;
    }
    if (tuple) yield ",";
    if (json && count) yield line(depth);
    yield close;
  }
  private leaf(n: Node, json: boolean): string {
    switch (n.kind) {
      case "none": return json ? "null" : "None";
      case "ellipsis": return "Ellipsis";
      case "notImplemented": return "NotImplemented";
      case "str": return json ? JSON.stringify(n.str) : quote(n.str);
      case "boolean": return json ? String(n.boolean) : n.boolean ? "True" : "False";
      case "int": case "bigint": return this.integer(n);
      case "float": return float(n.float);
      case "bytes": return "b" + quote(Buffer.from(n.bytes).toString("latin1"), true);
      case "complex": {
        const { real, imag } = n.complex;
        const part = (x: number) => float(x).replace(/\.0$/, "");
        if (Object.is(real, 0)) return `${part(imag)}j`;
        const sign = imag < 0 || Object.is(imag, -0) ? "-" : "+";
        return `(${part(real)}${sign}${part(Math.abs(imag))}j)`;
      }
      case "date": return `datetime.date(${date(n.date)})`;
      case "time": return `datetime.time(${time(n.time)})`;
      case "datetime": return `datetime.datetime(${date(n.datetime)}, ${time(n.datetime)})`;
      case "timezone": return zone(n.timezone);
      case "timedelta": return delta(n.timedelta.days, n.timedelta.seconds, n.timedelta.microseconds);
      case "exception": return `${n.exception.excType}(${Object.hasOwn(n.exception, "arg") ? quote(n.exception.arg!) : ""})`;
      case "decimal": return `Decimal(${quote(n.decimal)})`;
      case "path": return `PosixPath(${quote(n.path)})`;
      case "type": return `<class '${n.type.name}'>`;
      case "function": return `<function '${n.function.name}' external>`;
      case "builtinFunction": return `<built-in function ${n.builtinFunction}>`;
      case "module": return `<module ${quote(n.module.name)}>`;
      case "repr": return n.repr;
      case "cycle": return n.cycle;
      default: throw new Error(`unexpected Monty value type ${n.kind}`);
    }
  }
  private input(id: number, budget: { left: number }, depth = 0): unknown {
    if (--budget.left < 0 || depth > 400) throw new Error("tool arguments are too large");
    const n = this.node(id);
    switch (n.kind) {
      case "none": return null;
      case "boolean": return n.boolean;
      case "str": return n.str;
      case "float": if (Number.isFinite(n.float)) return n.float; break;
      case "int": case "bigint": {
        const value = Number(this.integer(n));
        if (Number.isSafeInteger(value)) return value;
        break;
      }
      case "list": case "tuple": return this.children(id, n[n.kind].items).map(i => this.input(i, budget, depth + 1));
      case "dict": return Object.fromEntries(this.pairs(id, n.dict.pairs).map(p => [this.string(p.key), this.input(p.value, budget, depth + 1)]));
    }
    throw new Error("tool arguments must be JSON values");
  }
  private string(id: number) {
    const n = this.node(id);
    if (n.kind !== "str") throw new Error("argument names must be strings");
    return n.str;
  }
  arguments(call: Arguments) {
    const budget = { left: 250_000 };
    return { args: call.args.map(i => this.input(i, budget)), kwargs: Object.fromEntries(call.kwargs.map(p => [this.string(p.key), this.input(p.value, budget)])) };
  }
  images(id: number) {
    const n = this.node(id);
    const sequence = n.kind === "list" ? n.list.items : n.kind === "tuple" ? n.tuple.items : undefined;
    const at = sequence ? this.children(id, sequence) : [id];
    const images = new Map<number, { type: "image"; mimeType: string; data: string; note?: string }>();
    for (const i of at) {
      const obj = this.node(i);
      if (obj.kind !== "dict") continue;
      const fields = new Map<string, string>();
      for (const p of this.pairs(i, obj.dict.pairs)) {
        const key = this.node(p.key), value = this.node(p.value);
        if (key.kind === "str" && value.kind === "str") fields.set(key.str, value.str);
      }
      const data = fields.get("data"), mimeType = fields.get("mimeType");
      if (fields.get("type") === "image" && typeof data === "string" && typeof mimeType === "string") images.set(i, { type: "image", data, mimeType, note: fields.get("note") });
    }
    return { images: at.flatMap(i => images.has(i) ? [images.get(i)!] : []), skip: new Set(images.keys()),
      rest: at.some(i => !images.has(i)) || !images.size };
  }
}

// Python uses scientific notation outside [-4, 16) and pads the exponent.
function float(n: number): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "nan" : n < 0 ? "-inf" : "inf";
  if (Object.is(n, -0)) return "-0.0";
  if (n !== 0 && (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e16)) return n.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function quote(s: string, bytes = false) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/[\s\S]/gu, c => {
    if (c === q || c === "\\") return "\\" + c;
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    const cp = c.codePointAt(0)!;
    if (bytes ? cp < 32 || cp >= 127 : c !== " " && /[\p{C}\p{Z}]/u.test(c)) {
      const [esc, digits] = cp <= 255 ? ["x", 2] : cp <= 65535 ? ["u", 4] : ["U", 8];
      return `\\${esc}${cp.toString(16).padStart(digits, "0")}`;
    }
    return c;
  }) + q;
}

const date = (d: DateFields) => `${d.year}, ${d.month}, ${d.day}`;
function time(t: TimeFields) {
  const parts = [String(t.hour), String(t.minute)];
  if (t.second || t.microsecond) parts.push(String(t.second));
  if (t.microsecond) parts.push(String(t.microsecond));
  if (Object.hasOwn(t, "offsetSeconds")) parts.push(`tzinfo=${zone({ offsetSeconds: t.offsetSeconds!, ...(Object.hasOwn(t, "timezoneName") ? { name: t.timezoneName } : {}) })}`);
  if (t.fold) parts.push(`fold=${t.fold}`);
  return parts.join(", ");
}
function delta(days: number, seconds: number, microseconds: number) {
  return `datetime.timedelta(${Object.entries({ days, seconds, microseconds }).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ") || "0"})`;
}
function zone(z: Zone) {
  const offset = z.offsetSeconds, name = Object.hasOwn(z, "name") ? z.name : undefined;
  if (!offset && name === undefined) return "datetime.timezone.utc";
  return `datetime.timezone(${delta(offset < 0 ? -1 : 0, offset < 0 ? 86400 + offset : offset, 0)}${name === undefined ? "" : `, ${quote(name)}`})`;
}

export class ValueBuilder {
  private nodes: Record<string, unknown>[] = [];
  node(value: Record<string, unknown>) { return this.nodes.push(value) - 1; }
  get values() { return { nodes: this.nodes, nodeCount: this.nodes.length }; }
  add(value: unknown): number {
    if (value == null) return this.node({ none: {} });
    if (typeof value === "string") return this.node({ str: value });
    if (typeof value === "boolean") return this.node({ boolean: value });
    if (typeof value === "number") return this.node(Number.isSafeInteger(value) && !Object.is(value, -0) ? { int: value } : { float: value });
    if (Array.isArray(value)) return this.node({ list: { items: value.map(v => this.add(v)) } });
    if (typeof value === "object") return this.node({ dict: { pairs: this.pairs(Object.entries(value)) } });
    throw new Error("tool returned a value that is not JSON");
  }
  pairs(entries: [string, unknown][]) { return entries.map(([key, value]) => ({ key: this.add(key), value: this.add(value) })); }
}
