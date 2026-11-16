import { fileConfiguration } from "@modular-agent/config-files";
export const configuration = (overrides: Record<string, unknown>) => fileConfiguration({ overrides });
