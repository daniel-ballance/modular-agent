import { join } from "node:path";
import type { Plugin, Provider } from "@modular-agent/core";
import { standardFileTools } from "@modular-agent/tools-files/sdk";
import { standardMcpTools } from "@modular-agent/tools-mcp/sdk";
import { codemode } from "./codemode.js";
import type { Paths } from "./configuration.js";
import { standardPrompt } from "./prompt.js";
import { scriptTestTools } from "./script.js";

export function standardPlugins(options: {
  paths: Paths;
  project?: string;
  serving?: boolean;
  projectMcp: Parameters<typeof standardMcpTools>[0]["servers"];
  script?: Provider;
}): Plugin[] {
  const plugins: Plugin[] = [
    standardFileTools({ spill: join(options.paths.state, "output"), project: options.project }),
    codemode(),
    standardPrompt(options.paths),
  ];
  if (!options.serving) plugins.push(standardMcpTools({ servers: options.projectMcp }));
  if (options.script) plugins.push(scriptTestTools());
  return plugins;
}
