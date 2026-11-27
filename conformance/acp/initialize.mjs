import { methods } from "@agentclientprotocol/sdk";

export async function checkInitialize(ctx, check, within) {
	const request = (method, params) => within(15000, ctx.request(method, params), method);
	const init = (params) => request(methods.agent.initialize, params);
	const ns = "modular-agent";
	const cases = [
		["version 0", { protocolVersion: 0 }, "unsupported_version"],
		["unknown binding", { protocolVersion: 2, _meta: { [ns]: { binding: "modular-agent-acp/3" } } }, "unsupported_version"],
		["non-object namespace", { protocolVersion: 2, _meta: { [ns]: [] } }, "invalid_params"],
		["null namespace", { protocolVersion: 2, _meta: { [ns]: null } }, "invalid_params"],
		["non-string binding", { protocolVersion: 2, _meta: { [ns]: { binding: 2 } } }, "invalid_params"],
		["missing version", {}],
		...["1", 1.5, -1, 65536, true, null, {}, []].map((version) =>
			[`version ${JSON.stringify(version)}`, { protocolVersion: version }]),
	];
	for (const [label, params, code] of cases) {
		const error = await init(params).then(() => null, (err) => err);
		check(`initialize: ${label} is refused`, error?.code === -32602 && (!code || error.data?.code === code), JSON.stringify(error));
		const list = await request(methods.agent.session.list, {}).then(() => null, (err) => err);
		check(`initialize: ${label} leaves the connection uninitialized`,
			list?.code === -32600 || (list?.code === -32602 && list.data?.code === "not_initialized"), JSON.stringify(list));
	}
	return init({ protocolVersion: 2, clientCapabilities: {}, _meta: { [ns]: { binding: "modular-agent-acp/1" } } });
}
