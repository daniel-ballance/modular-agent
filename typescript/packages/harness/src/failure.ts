export function failure(code: "invalid_composition" | "invalid_params" | "invalid_request" | "not_open" | "not_found" | "forbidden" | "not_supported" | "busy" | "lost" | "conflict" | "result_too_large" | "unavailable", message: string) {
	return Object.assign(new Error(message), { code });
}
