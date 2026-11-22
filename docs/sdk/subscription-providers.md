# Subscription Providers

Each SDK ships three Providers that use a person's own subscription plan instead of an API key ([ADR 0031](../adr/0031-subscription-providers.md)):

| Constructor | Provider id | Plan | How it reaches the models |
|---|---|---|---|
| `chatgpt(options)` | `chatgpt` | ChatGPT (Plus, Pro, Business) | OAuth sign-in, then the Responses API |
| `grok(options)` | `grok` | The X Subscription, and the SuperGrok and X Premium plans it replaces | OAuth device sign-in, then xAI's Responses API |
| `claude(options)` | `claude` | Claude (Pro, Max, Team) | The Claude Agent SDK, signed in through Claude Code |

They are ordinary [Providers](api.md#providers): an app adds them with `providers`, and they serve and load over the plugin binding like any other. They behave the same in all four languages.

## Terms of use

These Providers are for a person using their own plan, on their own machine. Each service sets its own terms, and an app that offers these Providers to other people must follow them:

- **Claude.** Anthropic does not permit third-party developers to offer Claude.ai login in their own applications, to route requests through Free, Pro, Max or Ultra credentials on behalf of their users, or to collect, store or intermediate Claude.ai credentials ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). So `claude()` has no sign-in of its own and never reads or stores a Claude credential: it uses the sign-in Claude Code keeps, made with Anthropic's own flow (`claude auth login`). A product for other people uses the `anthropic()` API-key Provider instead.
- **ChatGPT and Grok.** The sign-in uses the OAuth client of the vendor's own coding tool (Codex, Grok Build), because the vendors issue no client to other tools. An app built on these Providers is responsible for checking that its use is allowed.

## Logins

`chatgpt()` and `grok()` keep their sign-in in a **login file**, made with `subscriptionLogins(path)`:

- The file is JSON, `{"logins": {PROVIDER: LOGIN}, ...}`. Other top-level members are kept unchanged; `ma` keeps its `answers` there. A login is `{"type": "oauth", "access", "refresh", "expires", "account"?}`, with `expires` in milliseconds since the epoch already brought forward by five minutes, so a token is refreshed before it dies in a request.
- The file is created with mode 0600 and refused if it is readable by anyone else. Every change replaces the file atomically.
- Every change, and every token refresh, holds an exclusive kernel lock (`flock(2)`) from reading the file to replacing it, including while waiting for the token endpoint. The lock is on a sibling file with the same name and the extension `.lock` (`auth.json` is locked through `auth.lock`), created with mode 0600 and never removed, because replacing the login file gives it a new inode. Two processes refreshing at once therefore spend one refresh token: the second finds the new token when it gets the lock. Programs in different languages share the lock.
- A Provider reads its login when it needs a token. If the stored token expires within the margin, it refreshes under the lock and writes the result. A refresh the service refuses (`invalid_grant`) leaves the login in place and fails the request with ModelError `credentials`, saying to sign in again.
- `available()` is true when the file holds a login for the Provider. It does not call the service.

A login is never written to history, events, logs or errors, and never sent anywhere but the vendor's token and model endpoints.

## Signing in

`signIn(provider, logins, options)` signs in to `chatgpt` or `grok` and stores the login. It reports what the person must do through `options.onStep(step)`:

| Step | Meaning |
|---|---|
| `openAndPaste { url }` | Open `url` in a browser. When the browser returns, either the agent hears it on the loopback redirect, or the person pastes the address from the browser's address bar. |
| `deviceCode { url, code }` | Open `url` on any machine and enter `code`. |
| `waiting` | The SDK is polling; nothing to do. |

`options.device: true` asks for the device-code flow. Grok has only the device-code flow, so for `grok` the SDK ignores `device` and `paste` and never reports `openAndPaste`. `options.paste()` supplies a pasted line when the caller can read one; the SDK accepts the whole address, its query (`code=…&state=…`), `code#state`, or the bare code, checks a present state against the sign-in's, and asks again on a mismatch or an `error`. A redirect port already in use leaves pasting as the only return; with no `paste` either, the SDK uses the device code. `options.clientIdentity` is sent as below. The SDK opens no browser itself; the caller decides.

`signOut(provider, logins)` removes the login.

## Client identity

Requests and sign-ins name the client to the service: `originator` on ChatGPT requests and in the ChatGPT authorize address, and `referrer` when starting a [Grok](#grok) sign-in; Grok requests carry no identity. It is `modular-agent` unless the `clientIdentity` option names another: 1 to 64 characters from `A`–`Z`, `a`–`z`, `0`–`9`, `.`, `_` and `-`. Anything else is `invalid_composition` for a constructor and `invalid_params` for `signIn`. The identity is a label, not a credential.

## Models

`chatgpt()` and `grok()` offer the models in [subscription-models.json](subscription-models.json), which uses the format and reasoning rules of the [API-key model table](api-key-models.md). The `claude` entries map each level to the Agent SDK's `thinking` and `effort` options, in the TypeScript SDK's spelling; the Python SDK uses its own names for the same settings. Each SDK MUST ship it unchanged and test that its copy is byte-identical. The `models` option enrolls an unlisted id with its limits, as for the API-key Providers.

## ChatGPT

- **Sign-in.** OAuth 2.0 with PKCE against `https://auth.openai.com`, client `app_EMoamEEZ73f0CkXaXp7hrann`, scope `openid profile email offline_access`, redirect `http://localhost:1455/auth/callback`; the authorize address also carries `id_token_add_organizations=true`, `codex_cli_simplified_flow=true` and `originator`. The device flow uses `/api/accounts/deviceauth/usercode` and `/api/accounts/deviceauth/token`, with the page `https://auth.openai.com/codex/device`. `account` is the ChatGPT account id from the access token's `https://api.openai.com/auth` claim, `chatgpt_account_id`.
- **Requests.** The Responses API at `https://chatgpt.com/backend-api/codex/responses`, streamed, `store: false`, with the bearer token, `Content-Type: application/json`, `Accept: text/event-stream`, `User-Agent: modular-agent/VERSION` (the SDK's version), `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`, `originator`, and the session id as both `session-id` and `x-client-request-id`. Encrypted reasoning is requested and kept as `providerData`.

These are the values `ma` uses through each SDK's `chatgpt` Provider; the Rust SDK is the reference for the exact request.

## Grok

- **Sign-in.** The OAuth 2.0 device-code flow against `https://auth.x.ai`, client `b1a00492-073a-47ea-816f-4c329264a828`, scope `openid profile email offline_access grok-cli:access api:access`. Start with a form POST to `/oauth2/device/code` carrying `client_id`, `scope` and `referrer` (the client identity). Show `verification_uri_complete`, else `verification_uri`, and refuse either unless it is `https`; it currently points to `https://accounts.x.ai/oauth2/device`. Poll `/oauth2/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id` and `device_code` at the advertised `interval` (5 seconds if absent), within `expires_in` (900 seconds if absent). Carry on after `authorization_pending`, wait 5 seconds longer after each `slow_down`, and stop after `access_denied`, `authorization_denied` or `expired_token`. The login has no `account`.
- **Refresh.** A form POST to `/oauth2/token` with `grant_type=refresh_token`, `refresh_token` and `client_id`. If the answer has no `refresh_token`, the old one is kept. If it has no `expires_in`, the token is taken to last 3600 seconds.
- **Requests.** The Responses API at `https://api.x.ai/v1/responses`, streamed, `store: false`, with the bearer token, `Content-Type: application/json`, `Accept: text/event-stream` and `User-Agent: modular-agent/VERSION`, as for ChatGPT. Grok requests carry no client identity and none of Grok Build's own headers, such as `x-grok-*` or `X-XAI-Token-Auth`. The system prompt is the first `input` item, with role `system`, rather than `instructions`, and `maxOutput` becomes `max_output_tokens`, capped at the model's limit. Encrypted reasoning is requested and kept as `providerData`, and sent back on later requests to the same Provider.

The client is the one xAI registered for its own Grok Build CLI; xAI publishes none for other tools, and documents only API keys for `api.x.ai` ([research](../research/grok-x-subscription.md)). Used this way, it draws on the person's X Subscription; this was checked on a real account on 2026-11-22. xAI could stop accepting it at any time. These are the values `ma` uses; the Rust SDK is the reference for the exact request.

## Claude

- `claude()` reaches Claude through the Claude Agent SDK, used as a plain model endpoint: the host's system prompt with no Claude Code preset; only the host's tools shown to the model; Claude Code's own tools, settings files, hooks, memory, MCP configuration, skills and session files off. When the model asks for a tool, the request ends with `toolCall` parts and stop `toolUse`; nothing runs inside the Agent SDK. Text and reasoning arrive as pieces.
- TypeScript and Python use Anthropic's Agent SDK for their language. Anthropic publishes none for Rust or Go, so their `claude()` runs the TypeScript SDK's Claude program as a [process plugin](placement.md#a-plugin-in-another-process) and needs Node.js 22 or newer. The `program` option, or `MODULAR_AGENT_CLAUDE_SIDECAR`, names it; otherwise each SDK looks in its documented install location. A missing program is `invalid_composition` naming both.
- The catalog starts from the `claude` entries in [subscription-models.json](subscription-models.json), then takes what Claude Code reports the account offers.
- `available()` is true when Claude Code reports a Claude plan sign-in. If Claude Code is using an API key instead, `available()` is false and the reason names the key's source, so a plan is never silently replaced by metered use. Served, the Claude program sends that reason in `provider/available`.

## Checks

Each SDK MUST test offline, against loopback servers or by inspecting the built request: both ChatGPT sign-in flows, including paste forms, state mismatch and a busy redirect port; Grok's device sign-in, including `authorization_pending`, `slow_down`, denial, expiry and a refused non-`https` address; the authorize address or device form, and every request header, with the default and a configured client identity; refresh under the lock with two concurrent refreshers spending one refresh token; a refused refresh; the file mode check; and model mapping from the shared table. `claude()` is tested against the Agent SDK's fixtures, as the TypeScript sidecar's tests do today.

[Live checks](testing.md#live-checks) for subscriptions run only with `MODULAR_AGENT_LIVE=1` and `MODULAR_AGENT_LIVE_LOGINS` naming a login file, and skip each Provider without a login (for `claude`, without a Claude Code sign-in). They make one short request per Provider and never sign in.
