import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import type { OAuth } from "./auth.js";

export const vendors = ["openai-codex", "xai"] as const;
export type Vendor = typeof vendors[number];
export const labels: Record<Vendor, string> = { "openai-codex": "ChatGPT subscription", xai: "Grok subscription" };
// Pi's value is a placeholder until the services accept this client's own name.
export const CLIENT_IDENTITY = "pi";
const codex = { id: "app_EMoamEEZ73f0CkXaXp7hrann", scope: "openid profile email offline_access", token: "https://auth.openai.com/oauth/token",
  authorize: "https://auth.openai.com/oauth/authorize", deviceCode: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceToken: "https://auth.openai.com/api/accounts/deviceauth/token", devicePage: "https://auth.openai.com/codex/device",
  deviceRedirect: "https://auth.openai.com/deviceauth/callback" };
const xai = { id: "b1a00492-073a-47ea-816f-4c329264a828", scope: "openid profile email offline_access grok-cli:access api:access",
  token: "https://auth.x.ai/oauth2/token", deviceCode: "https://auth.x.ai/oauth2/device/code" };
const realEndpoints = { codexToken: codex.token, codexAuthorize: codex.authorize, codexDeviceCode: codex.deviceCode,
  codexDeviceToken: codex.deviceToken, xaiToken: xai.token, xaiDeviceCode: xai.deviceCode };
const LOOPBACK = "127.0.0.1";
const DEVICE_WAIT = 900_000;
const MARGIN = 300_000;
export type Step = { kind: "open" | "open-and-paste"; address: string } | { kind: "code"; address: string; code: string } | { kind: "note"; message: string };
/** Subscribe to terminal lines and return a cleanup function. */
type Pasted = (onLine: (line: string) => void) => () => void;

export function pastedCode(line: string, state: string): string | undefined {
  const input = line.trim();
  if (!input) return;
  let code: string | null, found: string | null;
  const question = input.indexOf("?");
  if (question !== -1 || input.includes("code=")) {
    const query = new URLSearchParams(question === -1 ? input : input.slice(question + 1).split("#", 1)[0]);
    if (question !== -1 && query.has("error")) {
      throw new Error(`the sign-in was not completed: ${query.get("error_description") ?? query.get("error")}`);
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
function failure(action: string, status: number, body: Fields) {
  const detail = [body.error, body.error_description].filter((v): v is string => typeof v === "string").join(": ");
  return new Error(`${action} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
}
function tokens(vendor: Vendor, body: Fields, previous?: string): OAuth {
  const access = string(body.access_token), refresh = string(body.refresh_token) ?? previous;
  if (!access) throw new Error("the sign-in answer has no access token");
  if (!refresh) throw new Error("the sign-in answer has no refresh token");
  return { type: "oauth", access, refresh, expires: Math.max(0, Date.now() + count(body.expires_in, 3600) * 1000 - MARGIN),
    ...(vendor === "openai-codex" ? { account: chatgptAccount(access) } : {}) };
}
type TestOptions = { endpoints: Partial<typeof realEndpoints>; port?: number; pollUnit?: number };
export function oauth(test?: TestOptions) {
  const ep = { ...realEndpoints };
  if (test) for (const [k, v] of Object.entries(test.endpoints)) ep[k as keyof typeof ep] = loopback(v);
  const endpoint = (name: keyof typeof ep) => {
    if (test && !test.endpoints[name]) throw new Error(`missing loopback endpoint ${name}`);
    return ep[name];
  };
  const exchange = async (code: string, verifier: string, redirect: string) => {
    const [status, body] = await post(endpoint("codexToken"), { grant_type: "authorization_code", client_id: codex.id, code, code_verifier: verifier, redirect_uri: redirect });
    if (!ok(status)) throw failure("the ChatGPT sign-in", status, body);
    return tokens("openai-codex", body);
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
  const xaiDevice = async (show: (s: Step) => void) => {
    const [status, body] = await post(endpoint("xaiDeviceCode"), { client_id: xai.id, scope: xai.scope, referrer: CLIENT_IDENTITY });
    if (!ok(status)) throw failure("starting the Grok sign-in", status, body);
    const field = (name: string) => {
      const value = string(body[name]);
      if (!value) throw new Error(`the Grok sign-in answer has no ${name}`);
      return value;
    };
    const address = string(body.verification_uri_complete) ?? field("verification_uri");
    if (!address.startsWith("https://")) throw new Error("the Grok sign-in gave an address that is not https");
    const code = field("user_code"), device_code = field("device_code");
    show({ kind: "code", address, code });
    return poll<OAuth>(count(body.interval, 5) || 5, count(body.expires_in, 900) * 1000, async () => {
      const [status, body] = await post(endpoint("xaiToken"), { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: xai.id, device_code });
      if (ok(status)) return tokens("xai", body);
      switch (body.error) {
        case "authorization_pending": return "pending";
        case "slow_down": return "slower";
        case "access_denied": case "authorization_denied": throw new Error("the Grok sign-in was denied");
        case "expired_token": throw new Error("the Grok sign-in code expired");
        default: throw failure("the Grok sign-in", status, body);
      }
    });
  };
  const codexDevice = async (show: (s: Step) => void) => {
    const [status, body] = await post(endpoint("codexDeviceCode"), { client_id: codex.id }, true);
    if (!ok(status)) throw new Error(`ChatGPT device sign-in is not available (HTTP ${status}); use the browser sign-in`);
    const device = string(body.device_auth_id), code = string(body.user_code);
    if (!device) throw new Error("the ChatGPT sign-in answer has no device id");
    if (!code) throw new Error("the ChatGPT sign-in answer has no code");
    const raw = typeof body.interval === "string" && /^\d+$/.test(body.interval.trim()) ? Number(body.interval) : body.interval;
    show({ kind: "code", address: codex.devicePage, code });
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
  const codexBrowser = async (show: (s: Step) => void, pasted?: Pasted) => {
    let server: ReturnType<typeof createServer> | undefined = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000 });
    server.listen(test?.port ?? 1455, LOOPBACK);
    try { await once(server, "listening"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (!pasted) {
        show({ kind: "note", message: "Port 1455 is in use, so the browser sign-in cannot return here. Using a code instead." });
        return codexDevice(show);
      }
      server = undefined;
      show({ kind: "note", message: "Port 1455 is in use, so paste the address the browser comes back to." });
    }
    const actual = server?.address();
    const redirect = test && typeof actual === "object" && actual
      ? `http://${LOOPBACK}:${actual.port}/auth/callback` : "http://localhost:1455/auth/callback";
    const verifier = randomBytes(32).toString("base64url"), state = randomBytes(16).toString("base64url");
    let timer: NodeJS.Timeout | undefined, stopPasting: (() => void) | undefined;
    try {
      const code = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("the sign-in was not completed in time")), DEVICE_WAIT);
        server?.on("request", (req, res) => {
          const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
          const send = (status: number, text: string) => res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" }).end(text);
          if (url.pathname !== "/auth/callback") { send(404, "Not found."); return; }
          const code = url.searchParams.get("code"), returned = url.searchParams.get("state");
          if (returned === state && code !== null) { send(200, "Signed in. You can close this tab and return to the terminal."); resolve(code); return; }
          send(400, "The sign-in did not complete. Return to the terminal.");
          reject(new Error(returned !== state ? "the sign-in came back with the wrong state" :
            `the sign-in was not completed: ${url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no code returned"}`));
        });
        show({ kind: pasted ? "open-and-paste" : "open", address: `${endpoint("codexAuthorize")}?${form({ response_type: "code", client_id: codex.id, redirect_uri: redirect, scope: codex.scope,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state,
          id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: CLIENT_IDENTITY })}` });
        let accepted = false;
        stopPasting = pasted?.(line => {
          if (accepted) return;
          try {
            const code = pastedCode(line, state);
            if (code !== undefined) { accepted = true; resolve(code); }
          } catch (error) {
            show({ kind: "note", message: `${(error as Error).message}. Paste it again.` });
          }
        });
      }).finally(() => { clearTimeout(timer); stopPasting?.(); server?.close(); });
      return await exchange(code, verifier, redirect);
    } finally { server?.closeAllConnections(); }
  };
  return {
    login(vendor: Vendor, device: boolean, show: (s: Step) => void, pasted?: Pasted) {
      return vendor === "xai" ? xaiDevice(show) : device ? codexDevice(show) : codexBrowser(show, pasted);
    },
    async refresh(vendor: Vendor, old: OAuth, signal?: AbortSignal) {
      const [status, body] = await post(endpoint(vendor === "xai" ? "xaiToken" : "codexToken"), {
        grant_type: "refresh_token", refresh_token: old.refresh, client_id: vendor === "xai" ? xai.id : codex.id,
      }, false, signal).catch(err => { throw new Error(`could not reach ${labels[vendor]} to refresh the sign-in: ${(err as Error).message}`); });
      if (!ok(status)) throw failure(`refreshing the ${labels[vendor]} sign-in (run \`ma login ${vendor}\`)`, status, body);
      return tokens(vendor, body, old.refresh);
    },
  };
}
