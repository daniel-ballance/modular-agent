import { responsesProvider, type ResponsesProviderOptions } from "./responses.js";

export type ChatGPTOptions = ResponsesProviderOptions;

export function chatgpt(options: ChatGPTOptions) {
  return responsesProvider("chatgpt", "https://chatgpt.com/backend-api/codex/responses", options);
}
