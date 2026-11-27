import { isDeepStrictEqual } from "node:util";

const comparable = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
export const wireEqual = (a: unknown, b: unknown) => isDeepStrictEqual(comparable(a), comparable(b));

/** The Harness uses the shared data shapes natively. Opaque fields pass through unchanged. */
export function toWire<T>(value: T): T {
	return value;
}

export function fromWire<T>(value: T): T {
	return value;
}
