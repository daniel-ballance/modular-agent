import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { historyClientOptions } from "./history.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
const bearer = (token: string) => `Bearer ${token}`;
const tokenSyntax = /^[A-Za-z0-9._~+/\-]+=*$/;

/** Relay the binding unchanged to an already validated, trusted history service.
 * Do not emulate its leases or deserialize its opaque JSON. */
export async function historyRelay({ upstream, token, port }: {
  upstream: { url: string; token: string }; token: string; port: number;
}) {
  if (!tokenSyntax.test(token)) throw new Error("Invalid history bearer token configuration");
  const validated = historyClientOptions(upstream.url, upstream.token);
  const target = new URL(validated.url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const expected = digest(bearer(token));
  const fail = (res: ServerResponse, status: number, code: string, error: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ code, error }));
  };
  await new Promise<void>((resolve, reject) => {
    const request = send(target, { path: target.pathname.replace(/\/$/, "") + "/v1", headers: { authorization: bearer(validated.token!) },
      signal: AbortSignal.timeout(10_000) }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("error", reject);
      response.on("data", chunk => {
        body += chunk;
        if (body.length > 4096) request.destroy(new Error("Invalid upstream history declaration"));
      });
      response.on("end", () => {
        try {
          const declaration = JSON.parse(body);
          if (response.statusCode !== 200 || declaration.binding !== "modular-agent-history/1" ||
              !Number.isSafeInteger(declaration.ttlMs) || declaration.ttlMs <= 0) throw new Error("Invalid upstream history declaration");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end();
  });
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ""))) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.setHeader("Connection", "close");
      req.resume();
      return fail(res, 401, "unauthorized", "A valid service token is required");
    }
    const path = req.url ?? "";
    if (!/^\/v1(?:[/?]|$)/.test(path)) {
      req.resume();
      return fail(res, 404, "not_found", "Unknown path");
    }
    const headers = { authorization: bearer(validated.token!) } as Record<string, string>;
    for (const key of ["content-length", "content-type", "content-encoding"]) {
      const value = req.headers[key];
      if (typeof value === "string") headers[key] = value;
    }
    const request = send(target, { method: req.method, path: target.pathname.replace(/\/$/, "") + path, headers,
      signal: AbortSignal.timeout(30_000) }, reply => {
      if (!reply.statusCode || reply.statusCode >= 300 && reply.statusCode < 400) { reply.destroy(); res.destroy(); return; }
      const headers: Record<string, string> = {};
      for (const key of ["content-type", "content-length", "allow", "www-authenticate"]) {
        const value = reply.headers[key];
        if (typeof value === "string") headers[key] = value;
      }
      res.writeHead(reply.statusCode, headers);
      reply.on("error", () => res.destroy());
      reply.pipe(res);
    });
    request.on("error", () => res.destroy()); // The upstream mutation may have committed.
    req.on("error", () => request.destroy());
    res.on("close", () => { if (!res.writableFinished) request.destroy(); });
    req.pipe(request);
  });
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
