import { appendFileSync, readFileSync } from "node:fs";
import { Transform } from "node:stream";

const maxLine = 64 * 1024 * 1024;
const directionOK = direction => direction === "hostToPlugin" || direction === "pluginToHost";

// Record complete frames before forwarding them. Both taps for a connection
// append synchronously to the same file, preserving observed order.
export function wireTap(file, direction) {
  if (!directionOK(direction)) throw new Error("Unknown plugin wire direction");
  let parts = [], size = 0;
  return new Transform({
    transform(chunk, _, done) {
      try {
        while (chunk.length) {
          const lf = chunk.indexOf(10);
          const part = lf === -1 ? chunk : chunk.subarray(0, lf);
          size += part.length;
          if (size > maxLine + 1) throw new Error("Plugin wire frame too large");
          parts.push(part);
          if (lf === -1) break;
          const line = Buffer.concat(parts);
          // Keep bytes as sent, including any CR. JSON is parsed separately.
          appendFileSync(file, JSON.stringify({ direction, base64: line.toString("base64") }) + "\n", { mode: 0o600 });
          this.push(line);
          this.push("\n");
          parts = [];
          size = 0;
          chunk = chunk.subarray(lf + 1);
        }
        done();
      } catch (error) { done(error); }
    },
    flush(done) {
      done(size ? new Error("Unterminated plugin wire frame") : undefined);
    },
  });
}

export function readWire(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((record, index) => {
    try {
      const { direction, base64 } = JSON.parse(record);
      if (!directionOK(direction) || typeof base64 !== "string") throw new Error();
      const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(base64, "base64"));
      const message = JSON.parse(raw);
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      return { direction, raw, message };
    } catch {
      throw new Error(`Invalid plugin wire frame at line ${index + 1}`);
    }
  });
}
