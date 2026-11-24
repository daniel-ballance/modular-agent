import assert from "node:assert/strict";
import { rejectBaggage } from "./privacy.mjs";

const control = new Set(["plugin/initialize", "plugin/shutdown", "host/problem", "host/credentials/read"]);
const field = (object, key) => object != null && Object.hasOwn(object, key);

export function parseContext(context) {
  assert(context && typeof context === "object", "Missing traceContext");
  rejectBaggage(context);
  assert(Object.keys(context).every(key => ["traceparent", "tracestate"].includes(key)), "Unexpected traceContext field");
  assert(!field(context, "tracestate") || typeof context.tracestate === "string", "Invalid tracestate");
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(context.traceparent);
  assert(match && /[1-9a-f]/.test(match[1]) && /[1-9a-f]/.test(match[2]), "Invalid traceparent");
  return { traceId: match[1], spanId: match[2] };
}

export function inspectWire(connections) {
  const calls = [], callbacks = [];
  for (const { plugin, frames } of connections) {
    assert(frames.length, "Missing plugin wire frames");
    const open = [new Map(), new Map()];
    let initialized = false, registration;
    for (const { direction, raw } of frames) {
      assert(typeof raw === "string", "Expected a raw plugin frame");
      const msg = JSON.parse(raw);
      rejectBaggage(msg);
      const side = direction === "hostToPlugin" ? 0 : direction === "pluginToHost" ? 1 : -1;
      assert(side >= 0 && msg?.jsonrpc === "2.0", "Invalid plugin frame");
      const { method, params, id } = msg;
      if (method === undefined) {
        const request = open[1 - side].get(id);
        assert(request, "Plugin response without a live request");
        assert(!field(msg, "traceContext") && !field(params, "traceContext") &&
          !field(msg.result, "traceContext") &&
          !field(msg.error, "traceContext") && !field(msg.error?.data, "traceContext"), "traceContext on a response");
        open[1 - side].delete(id);
        request.response = msg;
        if (request.method === "plugin/initialize") {
          registration = msg.result;
          assert(registration, "Missing plugin registration");
          assert.equal(registration.name, plugin, "Wire registration name");
        }
        continue;
      }
      assert(!field(msg, "traceContext"), "traceContext is outside params");
      if (method === "plugin/initialize") {
        assert(side === 0 && !initialized, "Unexpected plugin initialize");
        initialized = true;
      }
      if (!registration || control.has(method) || method.startsWith("$/")) {
        assert(!field(params, "traceContext"), "traceContext before registration or on a control message");
      }
      const request = { method, params, plugin };
      if (method === "tools/call" || method === "host/tools/call") {
        assert(registration, "Tool work before registration");
        assert.equal(side, method === "tools/call" ? 0 : 1, "Wrong plugin work direction");
        request.context = parseContext(params?.traceContext);
        if (method === "tools/call") calls.push(request);
        else {
          request.parent = open[0].get(params?.parentRequestId);
          assert(request.parent?.method === "tools/call", "Nested callback lacks a live tools/call parentRequestId");
          callbacks.push(request);
        }
      }
      if (id !== undefined) {
        assert(!open[side].has(id), "Duplicate live plugin request ID");
        open[side].set(id, request);
      }
    }
    assert(initialized && registration, "Missing plugin handshake");
  }
  return { calls, callbacks };
}
