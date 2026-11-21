import assert from "node:assert/strict";
import { test } from "node:test";
import { WireError, WirePeer } from "../src/wire.js";

test("the wire peer withholds a prepared reply when authority changes at handoff", async () => {
	let ready!: () => void, resume!: () => void;
	const entered = new Promise<void>(resolve => { ready = resolve; });
	const release = new Promise<void>(resolve => { resume = resolve; });
	let allowed = true;
	const frames: unknown[] = [];
	const host = new WirePeer(line => { frames.push(JSON.parse(line)); plugin.feed(line); });
	const plugin = new WirePeer(line => host.feed(line));
	host.handle("host/hook", (_, call) => {
		call.atReply(async send => {
			ready();
			await release;
			if (!allowed) throw new WireError("invalid_request", "The prepared reply is no longer current");
			send();
		});
		return { private: "prepared payload" };
	});
	const response = plugin.request("host/hook");
	await entered;
	assert.deepEqual(frames, []);
	allowed = false;
	resume();
	await assert.rejects(response, { code: "invalid_request" });
	assert.doesNotMatch(JSON.stringify(frames), /prepared payload/);
});
