import type { Plugin, ToolCall, ToolContext, ToolDefinition, ToolPending, ToolResult, ToolSource } from "@modular-agent/harness";
import { text } from "@modular-agent/harness";

const DEFINITION: ToolDefinition = {
	name: "ask_user",
	description: "Ask the user a question and get their answer. Give options when there is a short list of sensible answers. If the user doesn't answer soon, the call stays open and the answer arrives later.",
	parameters: {
		type: "object",
		properties: {
			question: { type: "string" },
			options: { type: "array", items: { type: "string" } },
			secret: { type: "string", description: "Ask for a secret, such as an API token, to keep under this name. You never see the value: the user's answer goes straight to the credential store." },
		},
		required: ["question"],
	},
	hints: { readOnly: true },
	callers: ["model"],
};

/**
 * A tool that asks the user a question from inside its own run. With waitMs set,
 * a question unanswered after that long leaves the call open past its turn; the
 * tool then runs again when the answer arrives, and asking again returns it.
 */
export class QuestionTool implements ToolSource {
	readonly id = "tools-question";
	constructor(private waitMs: () => number | undefined) {}
	tools(): ToolDefinition[] {
		return [DEFINITION];
	}
	async run(call: ToolCall, ctx: ToolContext): Promise<Omit<ToolResult, "callId"> | ToolPending> {
		const input = call.input as { question: string; options?: string[]; secret?: string };
		const wait = this.waitMs();
		const answer = await ctx.ask({
			kind: input.secret ? "secret" : input.options?.length ? "choice" : "text",
			// Under its own prefix, so a model can never overwrite a Provider's credential.
			...(input.secret ? { credential: `secret:${input.secret}` } : {}),
			question: String(input.question),
			options: input.options?.length ? input.options.map(String) : undefined,
			...(wait ? { timeLimitMs: wait, whenTimeLimit: "leaveOpen" as const } : {}),
		});
		if (answer.pending) return { pending: "Waiting for the user's answer" };
		if (answer.stored) return { status: "completed", content: [text(`The user gave the secret. It is kept as "${answer.stored}"; its value is not shown to you.`)], value: { answered: true, stored: answer.stored } };
		if (answer.declined || !answer.value) return { status: "completed", content: [text(`The user did not answer${answer.reason ? ` (${answer.reason})` : ""}.`)], value: { answered: false } };
		return { status: "completed", content: [text(`The user answered: ${answer.value}`)], value: { answered: true, answer: answer.value } };
	}
}

export function questionTool(options: { waitMs?: number } = {}): Plugin {
	return {
		name: "tools-question",
		setup(api) {
			const fromConfig = api.config().waitMs as number | undefined;
			api.provide("tool-source", new QuestionTool(() => options.waitMs ?? fromConfig));
		},
	};
}
