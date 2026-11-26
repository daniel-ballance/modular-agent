function maintain(sid, ttlMs, sentAt, renew) {
	let cutoff = sentAt + ttlMs / 2;
	let timer, pending, failure;
	let stopped = false;
	const expired = () => Error(`fixture writer lease for ${sid} reached its ${ttlMs / 2} ms loss cutoff`);

	function schedule(from) {
		const wait = from + ttlMs / 3 - performance.now();
		if (wait <= 0) {
			renewLease();
			return;
		}
		timer = setTimeout(renewLease, Math.min(2 ** 31 - 1, Math.floor(wait)));
		timer.unref();
	}

	function renewLease() {
		const start = performance.now();
		const nextCutoff = start + ttlMs / 2;
		const remaining = Math.min(cutoff, nextCutoff) - start;
		if (remaining <= 0) {
			failure = expired();
			return;
		}
		const signal = AbortSignal.timeout(Math.min(15_000, Math.ceil(remaining)));
		pending = renew(signal).then(reply => {
			if (performance.now() >= Math.min(cutoff, nextCutoff)) throw expired();
			if (reply.status !== 200 || reply.body?.ttlMs !== ttlMs) throw Error(`could not renew fixture writer lease for ${sid}`);
			cutoff = nextCutoff;
			if (!stopped) schedule(start);
		}).catch(error => { failure = error; });
	}

	if (performance.now() >= cutoff) failure = expired();
	else schedule(sentAt);
	return {
		async ready() {
			await pending;
			if (failure) throw failure;
			if (performance.now() >= cutoff) throw expired();
		},
		async stop() {
			stopped = true;
			clearTimeout(timer);
			await pending;
		},
	};
}

export function leaseFixtures(renew) {
	const writers = new Map();
	return {
		keep(sid, { lease, ttlMs }, sentAt) {
			writers.set(lease, maintain(sid, ttlMs, sentAt, signal => renew(sid, lease, signal)));
		},
		async ready(lease) { await writers.get(lease)?.ready(); },
		async stop(lease) {
			const writer = writers.get(lease);
			writers.delete(lease);
			await writer?.stop();
		},
		async close() {
			const pending = [...writers.values()].map(writer => writer.stop());
			writers.clear();
			await Promise.all(pending);
		},
	};
}
