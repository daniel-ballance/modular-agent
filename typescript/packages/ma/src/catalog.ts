import type { ToolDefinition } from "@modular-agent/core";

const [intro, lookup, image, exec] = [
  "# Functions in codemode\n\nYou have one tool, `codemode`, which runs Python. These functions exist inside it, on the `tools` object, and nowhere else. Call them as written; no import and no `await` is needed. Arguments go by keyword or in the order shown. A function returns a string unless its entry says otherwise, and raises `RuntimeError` when the call fails, is refused or is cancelled. Do several steps in one run when the later steps do not depend on your judgement of the earlier ones.\n",
  "\n## describe_tool(name: str)\nReturns a dict with the full description of the `tools` function of that name and the JSON schema of its parameters.\n\n## search_tools(query: str)\nReturns the functions whose name or description contains every word of the query, as a list of dicts with `name`, `signature` and `description`.\n",
  "\n`tools.read` on an image file (png, jpeg, gif, webp, bmp) returns a dict, not a string. To look at the image, make that dict the last expression of the run, alone or in a list.\n",
  "\n`tools.exec` returns a dict: `output` (stdout and stderr together), `exit_code`, `truncated`, `wall_time_seconds`, and `full_output_path` when the output was cut. A command that exits non-zero returns its dict; it does not raise.\n"
];

type Schema = { type?: string; items?: Schema };
const pythonType = (s?: Schema): string => {
  switch (s?.type) {
    case "string": return "str";
    case "integer": return "int";
    case "number": return "float";
    case "boolean": return "bool";
    case "array": return `list[${pythonType(s.items)}]`;
    case "object": return "dict";
    case "null": return "None";
    default: return "Any";
  }
};
const firstLine = (s: string) => [...s.split(/\r?\n/, 1)[0]].slice(0, 160).join("");
export function catalog(tools: ToolDefinition[]) {
  const functions = new Map(tools.filter(t => t.name !== "codemode" && (!t.callers || t.callers.includes("plugin"))).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(t => {
    const name = t.name.replace(/[^a-zA-Z0-9_]/gu, "_").replace(/^(?=\d)/, "_") || "_";
    const required = (t.parameters.required ?? []) as string[];
    const properties = (t.parameters.properties ?? {}) as Record<string, Schema>;
    const params = [...required, ...Object.keys(properties).filter(k => !required.includes(k))];
    const signature = `tools.${name}(${params.map(k => `${k}: ${pythonType(properties[k])}${required.includes(k) ? "" : " = None"}`).join(", ")})`;
    const description = t.description;
    const doc = { name, signature, description };
    return [name, { original: t.name, doc, describe: { ...doc, parameters: t.parameters, read_only: t.hints?.readOnly ?? false },
      bind(args: unknown[], kwargs: Record<string, unknown>) {
        const zipped = args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) && properties[params[0]]?.type !== "object";
        if (!zipped && args.length > params.length) throw new Error(`takes at most ${params.length} arguments, got ${args.length}`);
        const input: Record<string, unknown> = zipped ? Object.assign(Object.create(null), args[0]) : Object.assign(Object.create(null), Object.fromEntries(args.map((v, i) => [params[i], v])));
        for (const [k, v] of Object.entries(kwargs)) {
          if (Object.hasOwn(input, k)) throw new Error(`got two values for ${k}`);
          input[k] = v;
        }
        for (const [k, v] of Object.entries(input)) {
          if (v == null) delete input[k];
          else if (t.parameters.additionalProperties === false && !Object.hasOwn(properties, k)) throw new Error(`unexpected argument ${k}; the signature is ${signature}`);
        }
        for (const k of required) if (!Object.hasOwn(input, k)) throw new Error(`missing argument ${k}; the signature is ${signature}`);
        return input;
      } } ] as const;
  }));
  return {
    functions,
    prompt() {
      const long = functions.size <= 12;
      let text = intro;
      for (const { doc: d } of functions.values()) text += long ? `\n## ${d.signature}\n${d.description}\n` : `\n- \`${d.signature}\`: ${firstLine(d.description)}`;
      return text + (long ? "" : "\n") + lookup + (functions.has("read") ? image : "") + (functions.has("exec") ? exec : "");
    },
    search(query: string) {
      const words = query.trim().toLowerCase().split(/\s+/);
      return [...functions.values()].map(f => f.doc).filter(x => words.every(w => `${x.name} ${x.description}`.toLowerCase().includes(w)))
        .map(x => ({ ...x, description: firstLine(x.description) }));
    },
  };
}
