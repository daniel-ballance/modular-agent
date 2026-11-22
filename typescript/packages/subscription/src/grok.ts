import { responsesProvider, type ResponsesProviderOptions } from "./responses.js";

export type GrokOptions = ResponsesProviderOptions;

export function grok(options: GrokOptions) {
  return responsesProvider("grok", "https://api.x.ai/v1/responses", options);
}
