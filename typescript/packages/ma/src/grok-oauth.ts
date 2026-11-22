import { setTimeout as wait } from "node:timers/promises";
import { resolveClientIdentity, type OAuth, type ClientIdentityOptions } from "@modular-agent/subscription";

const xai = { id: "b1a00492-073a-47ea-816f-4c329264a828", scope: "openid profile email offline_access grok-cli:access api:access",
  token: "https://auth.x.ai/oauth2/token", deviceCode: "https://auth.x.ai/oauth2/device/code" };
const realEndpoints = { xaiToken: xai.token, xaiDeviceCode: xai.deviceCode };
const LOOPBACK = "127.0.0.1";
const MARGIN = 300_000;
export type Step = { kind: "code"; address: string; code: string };
export const loopback = (address: string) => {
  const url = new URL(address);
  if (url.protocol !== "http:" || url.hostname !== LOOPBACK || url.username || url.password) throw new Error("test endpoint must be numeric loopback HTTP");
  return url.href;
};
type Fields = Record<string, unknown>;
const string = (v: unknown) => typeof v === "string" && v ? v : undefined;
const count = (v: unknown, fallback: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fallback;
const ok = (s: number) => s >= 200 && s < 300;
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, m => `%${m.charCodeAt(0).toString(16).toUpperCase()}`);
const form = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
async function post(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<[number, Fields]> {
  const timeout = AbortSignal.timeout(30_000);
  const res = await fetch(url, { method: "POST", redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form(fields) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  return [res.status, body && typeof body === "object" ? body : {}];
}
function failure(action: string, status: number, body: Fields) {
  const detail = [body.error, body.error_description].filter((v): v is string => typeof v === "string").join(": ");
  return new Error(`${action} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
}
function tokens(body: Fields, previous?: string): OAuth {
  const access = string(body.access_token), refresh = string(body.refresh_token) ?? previous;
  if (!access) throw new Error("the sign-in answer has no access token");
  if (!refresh) throw new Error("the sign-in answer has no refresh token");
  return { type: "oauth", access, refresh, expires: Math.max(0, Date.now() + count(body.expires_in, 3600) * 1000 - MARGIN) };
}

type TestOptions = { endpoints: Partial<typeof realEndpoints>; pollUnit?: number };
export function grokOAuth({ clientIdentity: identity, test }: ClientIdentityOptions & { test?: TestOptions } = {}) {
  const clientIdentity = resolveClientIdentity(identity);
  const ep = { ...realEndpoints };
  if (test) for (const [k, v] of Object.entries(test.endpoints)) ep[k as keyof typeof ep] = loopback(v);
  const endpoint = (name: keyof typeof ep) => {
    if (test && !test.endpoints[name]) throw new Error(`missing loopback endpoint ${name}`);
    return ep[name];
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
    const [status, body] = await post(endpoint("xaiDeviceCode"), { client_id: xai.id, scope: xai.scope, referrer: clientIdentity });
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
      if (ok(status)) return tokens(body);
      switch (body.error) {
        case "authorization_pending": return "pending";
        case "slow_down": return "slower";
        case "access_denied": case "authorization_denied": throw new Error("the Grok sign-in was denied");
        case "expired_token": throw new Error("the Grok sign-in code expired");
        default: throw failure("the Grok sign-in", status, body);
      }
    });
  };
  return {
    login: xaiDevice,
    async refresh(old: OAuth, signal?: AbortSignal) {
      const [status, body] = await post(endpoint("xaiToken"), {
        grant_type: "refresh_token", refresh_token: old.refresh, client_id: xai.id,
      }, signal).catch(err => { throw new Error(`could not reach Grok subscription to refresh the sign-in: ${(err as Error).message}`); });
      if (!ok(status)) throw failure("refreshing the Grok subscription sign-in (run `ma login grok`)", status, body);
      return tokens(body, old.refresh);
    },
  };
}
