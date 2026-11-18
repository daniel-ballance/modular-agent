// History is opaque JSON. In particular, converting numbers to binary doubles
// would change records and make distinct entry IDs compare as equal on resend.
class Decimal {
	constructor(readonly raw: string) {}

	key(): string {
		const [mantissa, exponent = "0"] = this.raw.toLowerCase().split("e");
		const [whole, fraction = ""] = mantissa.replace(/^-/, "").split(".");
		const digits = (whole + fraction).replace(/^0+/, "");
		if (!digits) return "0";
		const significant = digits.replace(/0+$/, "");
		return `${mantissa.startsWith("-") ? "-" : ""}${significant}e${BigInt(exponent) + BigInt(digits.length - significant.length - fraction.length)}`;
	}
}

export type JsonObject = { [key: string]: Json };
export type Json = string | boolean | null | Decimal | JsonObject | Json[];

export function object(value: Json | undefined): value is JsonObject {
	return value !== null && typeof value === "object" && !(value instanceof Decimal) && !Array.isArray(value);
}

export function count(value: Json | undefined): number | undefined {
	if (!(value instanceof Decimal)) return;
	const n = Number(value.raw);
	if (Number.isSafeInteger(n) && n >= 0 && value.key() === new Decimal(String(n)).key()) return n;
}

export const nonnegativeNumber = (v: Json | undefined): v is Decimal => v instanceof Decimal && (!v.raw.startsWith("-") || v.key() === "0");

export function parseJson(text: string): Json {
	let i = 0;
	const whitespace = /[ \r\t\n]*/y;
	const token = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
	const stringRun = /[^"\\\x00-\x1f]*/y;
	const fail = (): never => { throw new SyntaxError("Invalid history JSON"); };
	const skip = () => { whitespace.lastIndex = i; whitespace.exec(text); i = whitespace.lastIndex; };
	const take = (c: string) => { skip(); if (text[i] !== c) return false; i++; return true; };
	const atom = () => {
		skip();
		if (text[i] === '"') {
			const start = i++;
			for (;;) {
				stringRun.lastIndex = i;
				stringRun.exec(text);
				i = stringRun.lastIndex;
				if (text[i] === '"') { i++; break; }
				if (text[i] !== '\\' || i + 1 >= text.length) return fail();
				i += 2;
			}
			const s = JSON.parse(text.slice(start, i)) as string;
			if (/[\uD800-\uDFFF]/u.test(s)) return fail();
			return s;
		}
		token.lastIndex = i;
		const m = token.exec(text);
		if (!m) return fail();
		i = token.lastIndex;
		const raw = m[0];
		if (raw === "true") return true;
		if (raw === "false") return false;
		if (raw === "null") return null;
		return new Decimal(raw);
	};
	const value = (depth: number): Json => {
		if (depth > 256) return fail();
		if (take("{")) {
			const obj = Object.create(null) as JsonObject;
			if (!take("}")) {
				do {
					const k = atom();
					if (typeof k !== "string" || Object.hasOwn(obj, k) || !take(":")) return fail();
					obj[k] = value(depth + 1);
				} while (take(","));
				if (!take("}")) return fail();
			}
			return obj;
		}
		if (take("[")) {
			const list: Json[] = [];
			if (!take("]")) {
				do { list.push(value(depth + 1)); } while (take(","));
				if (!take("]")) return fail();
			}
			return list;
		}
		return atom();
	};
	const parsed = value(0);
	skip();
	if (i !== text.length) return fail();
	return parsed;
}

export function encodeJson(value: Json, canonical = false): string {
	if (value instanceof Decimal) return canonical ? value.key() : value.raw;
	if (Array.isArray(value)) return `[${value.map((x) => encodeJson(x, canonical)).join(",")}]`;
	if (object(value)) {
		const keys = Object.keys(value);
		if (canonical) keys.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${encodeJson(value[k], canonical)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function equalJson(encoded: string, value: Json): boolean {
	return encoded === encodeJson(value) || encodeJson(parseJson(encoded), true) === encodeJson(value, true);
}
