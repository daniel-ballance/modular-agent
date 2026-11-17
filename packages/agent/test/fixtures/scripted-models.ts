// A model collection whose answers depend on the latest input, so a model gateway in
// another process can serve several tests in any order. Everything it needs comes as JSON options.
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory, type MutableModels } from "@earendil-works/pi-ai";
import type { Scripted } from "./faux-provider.js";

export function scriptedModels(options: { routes: Record<string, Scripted[]> }): MutableModels {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const textOf = (content: unknown) => (typeof content === "string" ? content : ((content as { type: string; text?: string }[] | undefined) ?? []).filter((p) => p.type === "text").map((p) => p.text).join(""));
	const route: FauxResponseFactory = (c) => {
		// The latest input with a route decides; the step is how many answers the model has given since.
		const at = c.messages.findLastIndex((m) => m.role === "user" && textOf(m.content) in options.routes);
		const input = at >= 0 ? textOf(c.messages[at].content) : "";
		const steps = options.routes[input] ?? [{ text: `no route for: ${textOf(c.messages.at(-1)?.content)}` }];
		const step = steps[Math.min(c.messages.slice(at + 1).filter((m) => m.role === "assistant").length, steps.length - 1)];
		return "tool" in step ? fauxAssistantMessage([fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText(step.text)]);
	};
	faux.setResponses(Array.from({ length: 1000 }, () => route));
	return models;
}
