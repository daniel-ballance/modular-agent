import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { scanExports } from "../telemetry/privacy.mjs";
import { startReceiver } from "../telemetry/receiver.mjs";

const here = fileURLToPath(import.meta.url);
const prompt = "reference-telemetry-prompt-sentinel";
const service = "ma-reference-telemetry";

function namespaceSkipReason() {
  if (process.platform !== "linux") return "default endpoint assertion needs a Linux network namespace";
  const probe = spawnSync("unshare", ["-rn", "--", "ip", "link", "set", "lo", "up"], { encoding: "utf8" });
  if (probe.status !== 0) {
    const detail = probe.error?.message ?? probe.stderr?.trim() ?? "";
    return `default endpoint assertion needs unprivileged unshare -rn and ip${detail ? ` (${detail})` : ""}`;
  }
}

export async function checkTelemetryExport(command, invoke, skip, reply) {
  const turn = async (cmd, label, env) => {
    const r = await invoke(cmd, { args: ["-p", prompt], env });
    assert.equal(r.exit, 0, `${label}: ma did not exit successfully: ${r.timeoutDetail ?? r.stderr.trim()}`);
    assert.equal(r.stdout.trimEnd(), reply, `${label}: scripted turn did not finish`);
  };
  const reason = namespaceSkipReason();
  if (reason) skip(reason);
  else {
    // The listener and the child must share the private loopback. No other run
    // can reach this listener or take its port.
    await turn([
      "unshare", "-rn", "--", "sh", "-c", 'ip link set lo up && exec "$@"', "sh",
      process.execPath, here, "--default-endpoint", ...command,
    ], "no endpoint");
  }

  const active = await startReceiver();
  try {
    await turn(command, "configured endpoint", {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: active.endpoint,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_TRACES_SAMPLER: "always_on",
      OTEL_SERVICE_NAME: service,
    });
    // ma flushes on normal exit. Check the whole payload, not a span query.
    const { payloads, errors } = active.snapshot();
    assert.equal(errors.length, 0, "configured endpoint: receiver rejected an export");
    scanExports(payloads, [prompt, reply]);
    const attr = (item, key) => item?.attributes?.find(a => a.key === key)?.value?.stringValue;
    const named = new Set();
    for (const payload of payloads) {
      for (const { resource, scopeSpans = [] } of payload.resourceSpans ?? []) {
        for (const { spans = [] } of scopeSpans) {
          for (const span of spans) {
            const operation = attr(span, "gen_ai.operation.name");
            if (operation !== "invoke_agent" && operation !== "chat") continue;
            named.add(operation);
            assert.equal(attr(resource, "service.name"), service, `${operation}: resource service.name`);
            if (operation === "invoke_agent") assert.equal(attr(span, "gen_ai.agent.name"), "ma", "invocation agent name");
          }
        }
      }
    }
    assert(named.has("invoke_agent"), "configured endpoint: no invocation span arrived");
    assert(named.has("chat"), "configured endpoint: no inference span arrived");
  } finally {
    await active.close();
  }

  const disabled = await startReceiver();
  try {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: new URL(disabled.endpoint).origin,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_TRACES_SAMPLER: "always_on",
      OTEL_SDK_DISABLED: "true",
    };
    await turn(command, "SDK disabled", env);
    const r = await invoke(command, { args: ["--declaration"], env });
    assert.equal(r.exit, 0, `SDK disabled: declaration failed: ${r.timeoutDetail ?? r.stderr.trim()}`);
    assert.equal(JSON.parse(r.stdout).telemetry, 1, "SDK disabled: declaration must still report telemetry: 1");
    assert.equal(disabled.connections, 0, "SDK disabled: connected to the OTLP endpoint");
  } finally {
    await disabled.close();
  }
}

if (process.argv[1] === here && process.argv[2] === "--default-endpoint") {
  const [command, ...args] = process.argv.slice(3);
  const receiver = await startReceiver({ port: 4318 });
  try {
    const child = spawn(command, args, { stdio: "inherit" });
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0, `ma exited with ${signal ?? code}`);
    assert.equal(receiver.connections, 0, "no endpoint configured: connected to the default OTLP endpoint");
  } finally {
    await receiver.close();
  }
}
