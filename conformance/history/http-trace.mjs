export async function tracedReply(method, route, send, trace, { strict = false } = {}) {
	const startedAtMs = Date.now();
	const start = performance.now();
	const request = { method, route, startedAtMs, status: null, body: null };
	trace.push(request);
	try {
		const res = await send();
		request.status = res.status;
		request.headersMs = Math.round(performance.now() - start);
		request.contentType = res.headers.get("content-type");
		request.cacheControl = res.headers.get("cache-control");
		request.body = await res.text();
		let body = null;
		try { body = JSON.parse(request.body); } catch (error) { if (strict) throw error; }
		return { status: res.status, headers: res.headers, body };
	} catch (error) {
		request.error = error.message;
		throw error;
	} finally {
		request.totalMs = Math.round(performance.now() - start);
	}
}
