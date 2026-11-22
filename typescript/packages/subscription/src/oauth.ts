import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { AgentError, ModelFailure } from "@modular-agent/core";
import type { OAuth, SubscriptionLogins } from "./logins.js";
import { resolveClientIdentity, type ClientIdentityOptions } from "./client-identity.js";

const codex = { id: "app_EMoamEEZ73f0CkXaXp7hrann", scope: "openid profile email offline_access", token: "https://auth.openai.com/oauth/token",
  authorize: "https://auth.openai.com/oauth/authorize", deviceCode: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceToken: "https://auth.openai.com/api/accounts/deviceauth/token", devicePage: "https://auth.openai.com/codex/device",
  deviceRedirect: "https://auth.openai.com/deviceauth/callback" };
const realEndpoints = { codexToken: codex.token, codexAuthorize: codex.authorize, codexDeviceCode: codex.deviceCode,
  codexDeviceToken: codex.deviceToken };
const LOOPBACK = "127.0.0.1";
const DEVICE_WAIT = 900_000;
const MARGIN = 300_000;
export type SignInStep = { kind: "openAndPaste"; url: string } | { kind: "deviceCode"; url: string; code: string } | { kind: "waiting" };
export type OAuthTestOptions = { endpoints: Partial<typeof realEndpoints>; port?: number; pollUnit?: number };
export interface SignInOptions extends ClientIdentityOptions {
  device?: boolean;
  onStep?(step: SignInStep): void;
  /** Return one line, or undefined at end of input. A rejected line is followed by another call with its problem. */
  paste?(signal: AbortSignal, problem?: string): string | undefined | Promise<string | undefined>;
  /** Offline fixtures only. Use only with test credentials. */
  test?: OAuthTestOptions;
}

export function pastedCode(line: string, state: string): string | undefined {
  const input = line.trim();
  if (!input) return;
  let code: string | null, found: string | null;
  const question = input.indexOf("?");
  if (question !== -1 || input.includes("code=")) {
    const query = new URLSearchParams(question === -1 ? input : input.slice(question + 1).split("#", 1)[0]);
    if (question !== -1 && query.has("error")) {
      throw new Error("the pasted address reports a sign-in error");
    }
    code = query.get("code");
    found = query.get("state");
  } else {
    const hash = input.indexOf("#");
    code = hash === -1 ? input : input.slice(0, hash);
    found = hash === -1 ? null : input.slice(hash + 1);
  }
  if (found !== null && found !== state) throw new Error("that address is from a different sign-in; paste the one from this sign-in");
  if (!code) throw new Error("no code found in what was pasted");
  return code;
}
export const loopback = (address: string) => {
  const url = new URL(address);
  if (url.protocol !== "http:" || url.hostname !== LOOPBACK || url.username || url.password) throw new Error("test endpoint must be numeric loopback HTTP");
  return url.href;
};
export function chatgptAccount(access: string) {
  let account: unknown;
  try {
    const payload = access.split(".")[1];
    if (!payload || !/^[A-Za-z0-9_-]+={0,2}$/.test(payload)) throw new Error();
    account = JSON.parse(Buffer.from(payload, "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch { throw new Error("the ChatGPT token is not in the expected form"); }
  if (typeof account !== "string") throw new Error("the ChatGPT token names no account; sign in again");
  return account;
}
type Fields = Record<string, unknown>;
const string = (v: unknown) => typeof v === "string" && v ? v : undefined;
const count = (v: unknown, fallback: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fallback;
const ok = (s: number) => s >= 200 && s < 300;
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, m => `%${m.charCodeAt(0).toString(16).toUpperCase()}`);
const form = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
async function post(url: string, fields: Record<string, string>, json = false, signal?: AbortSignal): Promise<[number, Fields]> {
  const timeout = AbortSignal.timeout(30_000);
  const res = await fetch(url, { method: "POST", redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded", ...(json ? {} : { accept: "application/json" }) },
    body: json ? JSON.stringify(fields) : form(fields) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  return [res.status, body && typeof body === "object" ? body : {}];
}
function tokens(body: Fields, previous?: string): OAuth {
  const access = string(body.access_token), refresh = string(body.refresh_token) ?? previous;
  if (!access) throw new Error("the sign-in answer has no access token");
  if (!refresh) throw new Error("the sign-in answer has no refresh token");
  return { type: "oauth", access, refresh, expires: Math.max(0, Date.now() + count(body.expires_in, 3600) * 1000 - MARGIN),
    account: chatgptAccount(access) };
}

export function chatgptOAuth(clientIdentity: string, test?: OAuthTestOptions) {
  const ep = { ...realEndpoints };
  if (test) for (const [k, v] of Object.entries(test.endpoints)) ep[k as keyof typeof ep] = loopback(v);
  const endpoint = (name: keyof typeof ep) => {
    if (test && !test.endpoints[name]) throw new Error(`missing loopback endpoint ${name}`);
    return ep[name];
  };
  const exchange = async (code: string, verifier: string, redirect: string) => {
    const [status, body] = await post(endpoint("codexToken"), { grant_type: "authorization_code", client_id: codex.id, code, code_verifier: verifier, redirect_uri: redirect });
    if (!ok(status)) throw new Error(`the ChatGPT sign-in failed (HTTP ${status})`);
    return tokens(body);
  };
  async function poll<T>(interval: number, limit: number, attempt: () => Promise<T | "pending" | "slower">) {
    const deadline = Date.now() + limit, unit = test?.pollUnit ?? 1000;
    for (;;) {
      await wait(Math.min(interval * unit, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) throw new Error("the sign-in was not completed in time");
      const value = await attempt();
      if (value === "slower") interval += 5;
      else if (value !== "pending") return value;
    }
  }
  const codexDevice = async (show: (s: SignInStep) => void) => {
    const [status, body] = await post(endpoint("codexDeviceCode"), { client_id: codex.id }, true);
    if (!ok(status)) throw new Error(`ChatGPT device sign-in is not available (HTTP ${status}); use the browser sign-in`);
    const device = string(body.device_auth_id), code = string(body.user_code);
    if (!device) throw new Error("the ChatGPT sign-in answer has no device id");
    if (!code) throw new Error("the ChatGPT sign-in answer has no code");
    const raw = typeof body.interval === "string" && /^\d+$/.test(body.interval.trim()) ? Number(body.interval) : body.interval;
    show({ kind: "deviceCode", url: codex.devicePage, code });
    show({ kind: "waiting" });
    const { authorization, verifier } = await poll(Math.max(1, count(raw, 5)), DEVICE_WAIT, async () => {
      const [status, body] = await post(endpoint("codexDeviceToken"), { device_auth_id: device, user_code: code }, true);
      if (ok(status)) {
        const authorization = string(body.authorization_code), verifier = string(body.code_verifier);
        if (!authorization || !verifier) throw new Error("the ChatGPT sign-in answer is incomplete");
        return { authorization, verifier };
      }
      const codeOf = (body.error as { code?: string } | undefined)?.code ?? body.error;
      if ([403, 404].includes(status) || codeOf === "deviceauth_authorization_pending") return "pending";
      if (codeOf === "slow_down") return "slower";
      throw new Error(`the ChatGPT sign-in failed (HTTP ${status})`);
    });
    return exchange(authorization, verifier, codex.deviceRedirect);
  };
  const codexBrowser = async (show: (s: SignInStep) => void, pasted?: SignInOptions["paste"]) => {
    let server: ReturnType<typeof createServer> | undefined = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000 });
    server.listen(test?.port ?? 1455, LOOPBACK);
    try { await once(server, "listening"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (!pasted) return codexDevice(show);
      server = undefined;
    }
    const actual = server?.address();
    const redirect = test && typeof actual === "object" && actual
      ? `http://${LOOPBACK}:${actual.port}/auth/callback` : "http://localhost:1455/auth/callback";
    const verifier = randomBytes(32).toString("base64url"), state = randomBytes(16).toString("base64url");
    let timer: NodeJS.Timeout | undefined;
    const paste = new AbortController();
    try {
      const code = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("the sign-in was not completed in time")), DEVICE_WAIT);
        server?.on("request", (req, res) => {
          const url = URL.parse(req.url ?? "/", `http://${LOOPBACK}`);
          const send = (status: number, text: string) => res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" }).end(text);
          if (url?.pathname !== "/auth/callback") { send(404, "Not found."); return; }
          const code = url.searchParams.get("code"), returned = url.searchParams.get("state");
          if (returned === state && code && !url.searchParams.has("error")) { send(200, "Signed in. You can close this tab and return to the terminal."); resolve(code); return; }
          send(400, "The sign-in did not complete. Return to the terminal.");
          reject(new Error(returned !== state ? "the sign-in came back with the wrong state" :
            "the browser returned without a sign-in code"));
        });
        show({ kind: "openAndPaste", url: `${endpoint("codexAuthorize")}?${form({ response_type: "code", client_id: codex.id, redirect_uri: redirect, scope: codex.scope,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state,
          id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: clientIdentity })}` });
        if (pasted) void (async () => {
          let problem: string | undefined;
          while (!paste.signal.aborted) {
            const line = await pasted(paste.signal, problem);
            if (line === undefined || paste.signal.aborted) {
              if (!server && !paste.signal.aborted) reject(new Error("No sign-in code was pasted"));
              return;
            }
            try {
              const code = pastedCode(line, state);
              if (code !== undefined) { resolve(code); return; }
              problem = "No code was pasted.";
            } catch (error) { problem = (error as Error).message; }
          }
        })().catch(reject);
      }).finally(() => { clearTimeout(timer); paste.abort(); server?.close(); });
      return await exchange(code, verifier, redirect);
    } finally { server?.closeAllConnections(); }
  };
  return {
    login(device: boolean, show: (s: SignInStep) => void, paste?: SignInOptions["paste"]) {
      return device ? codexDevice(show) : codexBrowser(show, paste);
    },
    async refresh(old: OAuth, signal?: AbortSignal): Promise<OAuth> {
      const [status, body] = await post(endpoint("codexToken"), {
        grant_type: "refresh_token", refresh_token: old.refresh, client_id: codex.id,
      }, false, signal).catch(() => { throw new ModelFailure({ kind: "temporary", message: "Could not reach the ChatGPT token endpoint." }); });
      if (!ok(status)) {
        const code = (body.error as { code?: string } | undefined)?.code ?? body.error;
        const refused = code === "invalid_grant" || status === 401 || status === 403;
        throw new ModelFailure({ kind: refused ? "credentials" : status >= 500 || status === 429 ? "temporary" : "other",
          message: refused ? "ChatGPT refused the refresh. Sign in again." : `ChatGPT refresh failed (HTTP ${status}).` });
      }
      return tokens(body, old.refresh);
    },
  };
}

export async function signIn(provider: "chatgpt", logins: SubscriptionLogins, options: SignInOptions = {}): Promise<void> {
  if (provider !== "chatgpt") throw new AgentError("invalid_params", "Only chatgpt supports SDK sign-in");
  let identity: string;
  try { identity = resolveClientIdentity(options.clientIdentity); }
  catch (error) { throw new AgentError("invalid_params", (error as Error).message); }
  const login = await chatgptOAuth(identity, options.test).login(!!options.device, options.onStep ?? (() => {}), options.paste);
  await logins.setLogin(provider, login);
}

export async function signOut(provider: "chatgpt", logins: SubscriptionLogins): Promise<void> {
  if (provider !== "chatgpt") throw new AgentError("invalid_params", "Only chatgpt supports SDK sign-out");
  await logins.setLogin(provider);
}
