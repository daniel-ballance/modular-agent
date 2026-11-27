import assert from "node:assert/strict";
import { test } from "node:test";
import { WireProvider } from "../src/provider-host.js";
import { WirePeer } from "../src/wire.js";

test("a blank wire reason uses the generic host error", { timeout: 5_000 }, async () => {
	const host = new WirePeer(line => queueMicrotask(() => plugin.feed(line)));
	const plugin = new WirePeer(line => queueMicrotask(() => host.feed(line)));
	let reason: string;
	plugin.handle("provider/available", () => ({ available: false, reason }));
	const provider = new WireProvider(host, "beacon",
		{ keepsState: false, runsTools: false, liveSessions: false, safeToRepeat: false }, [], () => {
			assert.fail("Unavailable Provider dispatched a request");
		});
	try {
		for (reason of ["", "   "]) {
			assert.deepEqual(await provider.availability(), { available: false });
			await assert.rejects(
				provider.request({ provider: "beacon", id: "demo" },
					{ systemPrompt: "", messages: [], tools: [], settings: {} }, { signal: new AbortController().signal }),
				{ message: "Provider is not available" },
			);
		}
	} finally {
		host.close();
		plugin.close();
	}
});
