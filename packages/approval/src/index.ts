import type { Plugin, ToolCall, ToolDefinition } from "@modular-agent/harness";

/**
 * - ask:   ask before any tool call that isn't read-only (the default)
 * - all:   ask before every tool call
 * - never: never ask; refuse every call that would need asking
 * - off:   never ask; allow everything, as vanilla Pi does
 */
export type ApprovalPolicy = "ask" | "all" | "never" | "off";
const POLICIES: ApprovalPolicy[] = ["ask", "all", "never", "off"];

function summary(call: ToolCall): string {
	const text = typeof call.input.command === "string" ? call.input.command : JSON.stringify(call.input, null, 2);
	return text.length > 2000 ? text.slice(0, 2000) + "…" : text;
}

/**
 * Asks before a tool call runs, at the "before a tool call" hook point.
 * Approval fails closed: only an explicit allow lets the call run.
 * Each question is keyed by its tool call, so after a restart a durable
 * Runtime reopens the same question rather than asking a new one.
 */
export function approval(options: { policy?: ApprovalPolicy; /** Leave the question open past its turn after this long. */ waitMs?: number } = {}): Plugin {
	return {
		name: "approval",
		setup(api) {
			const fallback = options.policy ?? (api.config().policy as ApprovalPolicy | undefined) ?? "ask";
			const waitOf = (sessionId: string) => (api.session(sessionId).settings.approvalWaitMs as number | undefined) ?? options.waitMs ?? (api.config().waitMs as number | undefined);
			const policyOf = (sessionId: string) => (api.session(sessionId).settings.approvalPolicy as ApprovalPolicy | undefined) ?? fallback;

			api.on("tool.before", async (p: { sessionId: string; call: ToolCall; definition?: ToolDefinition }) => {
				const policy = policyOf(p.sessionId);
				if (policy === "off") return undefined;
				if (policy !== "all" && p.definition?.hints?.readOnly) return undefined;
				if (policy === "never") return { refuse: `The approval policy is "never", so ${p.call.name} was refused without asking.` };
				const answer = await api.ask(p.sessionId, {
					kind: "approval",
					key: `approval:${p.call.id}`,
					question: `Allow ${p.call.name}?`,
					details: summary(p.call),
					toolCallId: p.call.id,
					...(waitOf(p.sessionId) ? { timeLimitMs: waitOf(p.sessionId), whenTimeLimit: "leaveOpen" as const } : {}),
				});
				if (answer.pending) return { pending: "Waiting for approval" };
				if (answer.declined || answer.value !== "allow") return { refuse: `${p.call.name} was not approved${answer.reason ? ` (${answer.reason})` : ""}.` };
				return undefined;
			});

			api.registerCommand("approvals", {
				description: "Show or set the approval policy: ask, all, never or off",
				run: async (args, ctx) => {
					const wanted = args.trim() as ApprovalPolicy;
					if (!wanted) return `Approval policy: ${policyOf(ctx.sessionId)}`;
					if (!POLICIES.includes(wanted)) return `Unknown policy. Use one of: ${POLICIES.join(", ")}`;
					await api.setSetting(ctx.sessionId, "approvalPolicy", wanted, ctx.actorId);
					return `Approval policy set to ${wanted}`;
				},
			});
		},
	};
}
