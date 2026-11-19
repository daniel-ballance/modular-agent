export type ErrorCode =
  | "invalid_params" | "invalid_request" | "invalid_composition" | "forbidden"
  | "not_found" | "not_open" | "busy" | "held" | "conflict" | "cancelled"
  | "not_supported" | "turn_limit" | "unknown_handler" | "withheld"
  | "result_too_large" | "message_too_large" | "lost" | "internal";

export class AgentError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly data?: unknown, cause?: unknown) {
    super(message, { cause });
    this.name = "AgentError";
  }
}

const codes = new Set<string>([
  "invalid_params", "invalid_request", "invalid_composition", "forbidden", "not_found",
  "not_open", "busy", "held", "conflict", "cancelled", "not_supported", "turn_limit",
  "unknown_handler", "withheld", "result_too_large", "message_too_large", "lost", "internal",
]);

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function sdkError(error: unknown, fallback: ErrorCode = "internal"): AgentError {
  if (error instanceof AgentError) return error;
  const e = error as { code?: string; name?: string; data?: unknown } | null;
  const code = e?.code === "ENOENT" ? "not_found"
    : e?.code === "ELOCKED" ? "held" : e?.name === "AbortError" ? "cancelled"
    : e?.code && codes.has(e.code) ? e.code as ErrorCode : fallback;
  return new AgentError(code, messageOf(error), e?.data, error);
}

export async function checked<T>(work: () => T | Promise<T>, fallback?: ErrorCode): Promise<T> {
  try { return await work(); }
  catch (error) { throw sdkError(error, fallback); }
}
