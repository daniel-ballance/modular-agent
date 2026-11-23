import assert from "node:assert/strict";

const contentKey = /^(?:baggage|authorization|proxy.authorization|credential(?:s|.value)?|password|secret(?:.value)?|access.token|api.key|launch.env(?:ironment)?|gen_ai\.(?:prompt|completion|system_instructions|input\.messages|output\.messages|tool\.definitions|tool\.call\.(?:arguments|result)|output\.reasoning)|exception\.(?:message|stacktrace)|(?:modular_agent\.)?(?:input\.content|question\.(?:text|body|answer)|tool\.(?:arguments|input|result|output)|history\.(?:body|payload|entries)|error\.message))$/i;

export function scanExports(payloads, sentinels) {
  assert(sentinels.length && sentinels.every(text => typeof text === "string" && text.length), "Missing fixture sentinels");
  function scan(text, path) {
    assert(!sentinels.some(sentinel => text.includes(sentinel)), `Fixture content exported at ${path}`);
  }
  function walk(value, path) {
    if (value === null || value === undefined) return;
    if (typeof value !== "object") {
      scan(String(value), path);
      return;
    }
    let index = 0;
    for (const [key, child] of Object.entries(value)) {
      const at = `${path}.${index++}`;
      scan(key, at);
      assert(!contentKey.test(key), `Forbidden telemetry field at ${at}`);
      if (key === "key" && typeof child === "string") {
        assert(!contentKey.test(child), `Forbidden telemetry attribute at ${at}`);
      }
      if (key === "bytesValue" && typeof child === "string") scan(Buffer.from(child, "base64").toString("utf8"), at);
      if (key === "status" && child && typeof child === "object") {
        assert(!child.message, `Telemetry status carries a diagnostic at ${at}`);
      }
      walk(child, at);
    }
  }
  walk(payloads, "export");
}

export function rejectBaggage(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert(!/(^|[._-])baggage$/i.test(key), "Baggage on plugin wire or in a checkpoint");
    rejectBaggage(child);
  }
}
