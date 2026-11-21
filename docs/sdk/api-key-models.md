# API-key model table

The `openai()` and `anthropic()` Providers use [api-key-models.json](api-key-models.json). It covers OpenAI Responses and Anthropic Messages with API keys, not subscription adapters. Each SDK MUST ship this file unchanged. Each SDK's tests MUST check that its shipped copy is byte-identical to `docs/sdk/api-key-models.json`.

## Format

The top-level object contains a `models` array. Each entry has a `provider` (`openai` or `anthropic`) and an exact API model `id`. The pair is unique. An alias has its own entry; an SDK MUST NOT infer mappings from a prefix or version suffix. `contextWindow` and `maxOutput` are the limits in tokens for the ordinary API, not beta or batch limits. The table omits a limit if the vendor does not document it. `input` lists the advertised input types. `reasoning` describes whether the model can reason, independently of whether it offers a choice of level.

`levels` maps each offered [shared reasoning level](../bindings/data.md#models) to the JSON fields to send in the vendor request. Its keys, in shared level order, are the model's `ModelInfo.thinking` list. An empty object means no verified mapping: omit `ModelInfo.thinking` and send no reasoning controls. Vendor `max` is not a shared level and is not an alias for `xhigh`.

## Sending a request

- When the level is unset, send no reasoning controls. The vendor default applies; unset does not mean `off`.
- For an explicit level, use the [shared fallback](../bindings/data.md#models): select the nearest offered level no higher than the requested one, or send no reasoning controls if none qualifies. Send only the chosen entry's reasoning fields. Leave unrelated request fields intact.
- For a mapping with `thinking.type: "enabled"`, `budget_tokens` is the target. Send the smaller of the target and `max_tokens - 1`, where `max_tokens` is the final Anthropic request's output limit. If that leaves fewer than 1,024 tokens for thinking, send the entry's `off` mapping instead, with no effort. An `enabled` mapping requires an `off` mapping in the same entry.
- Each constructor MUST let a developer explicitly enroll an unlisted model id with its limits and input types. It offers no reasoning levels and sends no reasoning controls. An id neither listed nor enrolled is unknown and follows the [usual errors](api.md#providers). Do not guess settings from another model, probe the vendor to find levels, or change levels in response to a rejection.

Each SDK MUST test request mapping offline, including an unset level, an unsupported level with no lower choice, adaptive thinking with and without `off`, a manual budget capped by `max_tokens`, and an enrolled id with no mapping.

## Vendor sources

- OpenAI: [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create) defines `reasoning.effort`. The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort) explains model-dependent effort. The model pages for [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-5.2](https://developers.openai.com/api/docs/models/gpt-5.2) and [GPT-5](https://developers.openai.com/api/docs/models/gpt-5) give the limits, modalities and accepted efforts. [Models retrieve](https://developers.openai.com/api/reference/resources/models/methods/retrieve) does not report which levels a model accepts.
- Anthropic: the [thinking support table](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#thinking-support-defaults-and-rejected-configurations-by-model), [effort table](https://platform.claude.com/docs/en/build-with-claude/effort#effort-levels), [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost) and [manual budget rules](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#budget-rules-and-tuning) define the request fields and model restrictions. The model pages for [Sonnet 4.6](https://platform.claude.com/docs/en/models/sonnet-4-6/overview), [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [Opus 4.5](https://platform.claude.com/docs/en/models/opus-4-5/overview) and [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview) give the ids, limits and input types. [Models retrieve](https://platform.claude.com/docs/en/api/models/retrieve) reports thinking and effort capabilities, but does not replace this table.

Sonnet 5.5's `between_tools` mode still thinks between tool calls, so it is not `off`. Opus 5.5 does not accept `disabled`. Haiku 5.5, the default for the [Anthropic live checks](testing.md#live-checks), accepts `disabled` at `high` or below; the vendor default is `medium`, so its `off` mapping sends no effort. Opus 4.5 accepts both manual thinking and effort; the table uses both for positive levels.
