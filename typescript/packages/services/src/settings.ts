/** Refuse misspellings before a service does any work. */
export function checkSettings(service: string, options: unknown, ...known: string[]): void {
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new Error(`The ${service} service settings must be an object`);
	}
	for (const key of Object.keys(options)) {
		if (!known.includes(key)) throw new Error(`Unknown ${service} service setting: ${JSON.stringify(key)}`);
	}
}
