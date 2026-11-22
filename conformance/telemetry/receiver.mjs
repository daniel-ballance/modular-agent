import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs";

const proto = new protobuf.Root();
const protoDir = new URL("./proto/", import.meta.url);
proto.resolvePath = (_, target) => fileURLToPath(new URL(target, protoDir));
proto.loadSync("opentelemetry/proto/collector/trace/v1/trace_service.proto");
const service = "opentelemetry.proto.collector.trace.v1";
const request = proto.lookupType(service + ".ExportTraceServiceRequest");
const response = proto.lookupType(service + ".ExportTraceServiceResponse");
const success = response.encode({}).finish();
const limit = 64 * 1024 * 1024;
const array = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Expected an OTLP list");
  return value;
};

// OTLP JSON uses hex IDs, unlike ordinary protobuf JSON. Keep other bytes
// in base64 and keep 64-bit integers as strings to avoid rounding.
function hexIds(span) {
  for (const key of ["traceId", "spanId", "parentSpanId"]) {
    if (span[key] !== undefined) span[key] = Buffer.from(span[key], "base64").toString("hex");
  }
  for (const link of array(span.links)) hexIds(link);
}

function spansIn(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an OTLP object");
  const spans = [];
  for (const resource of array(body.resourceSpans)) {
    for (const scope of array(resource.scopeSpans)) {
      for (const span of array(scope.spans)) {
        if (!span || typeof span !== "object" || Array.isArray(span)) throw new Error("Expected a span object");
        spans.push(span);
      }
    }
  }
  return spans;
}

export async function startReceiver() {
  const spans = [], payloads = [], errors = [];
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const snapshot = () => structuredClone({ spans, payloads, errors });
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/traces" || req.method !== "POST") {
      res.writeHead(req.url === "/v1/traces" ? 405 : 404).end();
      return;
    }
    const type = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    const encoding = req.headers["content-encoding"];
    try {
      if (type !== "application/json" && type !== "application/x-protobuf") {
        throw Object.assign(new Error("Unsupported OTLP content type"), { status: 415 });
      }
      if (encoding && encoding !== "identity" && encoding !== "gzip") {
        throw Object.assign(new Error("Unsupported OTLP content encoding"), { status: 415 });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size <= limit) chunks.push(chunk);
      }
      if (size > limit) throw Object.assign(new Error("OTLP request too large"), { status: 413 });
      const encoded = Buffer.concat(chunks);
      const body = encoding === "gzip" ? gunzipSync(encoded, { maxOutputLength: limit }) : encoded;
      const isJson = type === "application/json";
      const payload = isJson ? JSON.parse(body.toString("utf8"))
        : request.toObject(request.decode(body), { longs: String, bytes: String });
      const batch = spansIn(payload);
      if (!isJson) batch.forEach(hexIds);
      // Publish spans once the successful response has been handed to the socket.
      res.writeHead(200, { "content-type": type }).end(isJson ? "{}" : success, () => {
        payloads.push(payload);
        for (const span of batch) spans.push(span);
        events.emit("change");
      });
    } catch (error) {
      errors.push(error.status ? error.message : "Invalid OTLP trace request");
      res.writeHead(error.status ?? 400).end();
      events.emit("change");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  function waitFor(predicate, { timeoutMs = 5_000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for spans (received ${spans.length})`)), timeoutMs);
      const finish = (error, value) => {
        clearTimeout(timer);
        events.off("change", check);
        events.off("close", closed);
        if (error) reject(error);
        else resolve(value);
      };
      const closed = () => finish(new Error("OTLP receiver closed"));
      const check = () => {
        try {
          if (errors.length) throw new Error(errors[0]);
          const value = snapshot();
          if (predicate(value.spans)) finish(null, value);
        } catch (error) { finish(error); }
      };
      events.on("change", check);
      events.on("close", closed);
      check();
    });
  }

  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/traces`,
    snapshot,
    waitFor,
    async close() {
      events.emit("close");
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
