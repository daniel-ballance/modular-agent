/**
 * This build's shapes to and from the shared data shapes (docs/bindings/data.md).
 * They differ in two places: reasoning parts ("thinking" here, "reasoning" there)
 * and the safe-to-repeat hint ("idempotent" here, "safeToRepeat" there).
 */
type Json = any;

function walk(value: Json, part: (o: Record<string, Json>) => Record<string, Json>): Json {
	if (Array.isArray(value)) return value.map((v) => walk(v, part));
	if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value;
	const out: Record<string, Json> = {};
	for (const [k, v] of Object.entries(value)) out[k] = walk(v, part);
	return part(out);
}

export function toWire(value: Json): Json {
	return walk(value, (o) => {
		if (o.type === "thinking" && typeof o.thinking === "string") {
			const { thinking, type: _t, ...rest } = o;
			return { ...rest, type: "reasoning", text: thinking };
		}
		if (o.hints && typeof o.hints === "object" && "idempotent" in o.hints) {
			const { idempotent, ...hints } = o.hints;
			return { ...o, hints: { ...hints, safeToRepeat: idempotent } };
		}
		return o;
	});
}

export function fromWire(value: Json): Json {
	return walk(value, (o) => {
		if (o.type === "reasoning") {
			const { text, type: _t, ...rest } = o;
			return { ...rest, type: "thinking", thinking: typeof text === "string" ? text : "" };
		}
		if (o.hints && typeof o.hints === "object" && "safeToRepeat" in o.hints) {
			const { safeToRepeat, ...hints } = o.hints;
			return { ...o, hints: { ...hints, idempotent: safeToRepeat } };
		}
		return o;
	});
}
