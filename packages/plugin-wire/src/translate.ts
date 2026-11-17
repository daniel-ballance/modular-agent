/** The Harness uses the shared data shapes natively. Opaque fields pass through unchanged. */
export function toWire<T>(value: T): T {
	return value;
}

export function fromWire<T>(value: T): T {
	return value;
}
