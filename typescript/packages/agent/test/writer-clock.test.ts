import assert from "node:assert/strict";
import { test } from "node:test";
import { sleepAwareClock } from "@modular-agent/services";

/** A pair of fake clocks: the monotonic one stops while "asleep", the wall clock does not. */
function clocks() {
	let monotonic = 1_000, wall = 1_800_000_000_000;
	return {
		clock: () => sleepAwareClock(() => monotonic, () => wall),
		run(ms: number) { monotonic += ms; wall += ms; },
		sleep(ms: number) { wall += ms; },
		stepWall(ms: number) { wall += ms; },
	};
}

test("the writer clock counts ordinary running time once", () => {
	const c = clocks(), clock = c.clock();
	c.run(400);
	assert.equal(clock.now(), 400);
	c.run(100);
	assert.equal(clock.now(), 500);
});

test("the writer clock counts time the machine spent asleep", () => {
	const c = clocks(), clock = c.clock();
	c.run(100);
	clock.now();
	c.sleep(3_600_000);
	c.run(50);
	assert.equal(clock.now(), 100 + 3_600_050, "a sleep advances the clock, so a lease taken before it has expired");
});

test("a small wall-clock correction neither hides time nor ends leases", () => {
	const c = clocks(), clock = c.clock();
	c.run(1_000);
	c.stepWall(-40); // within the tolerance, covered by the margin
	assert.equal(clock.now(), 1_000);
	assert.ok(clock.margin > 40);
});

test("a wall clock stepped back could hide a sleep, so leases measured before it expire", () => {
	const c = clocks(), clock = c.clock();
	c.run(100);
	const before = clock.now();
	c.sleep(60_000);
	c.stepWall(-61_000);
	c.run(10);
	const after = clock.now();
	assert.ok(after - before >= 86_400_000, `jumped ${after - before} ms`);
	c.run(10);
	assert.equal(clock.now(), after + 10, "after the jump it counts normally again");
});

test("the writer clock never goes backwards", () => {
	const c = clocks(), clock = c.clock();
	let last = clock.now();
	for (const step of [5, -3, 20, -400, 0, 7]) {
		if (step >= 0) c.run(step); else c.stepWall(step);
		const now = clock.now();
		assert.ok(now >= last);
		last = now;
	}
});
