export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
const size = Buffer.byteLength;
export const formatSize = (n: number) => n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`;
const lines = (s: string) => s ? (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n") : [];
export function cut(s: string, tail = false, maxLines = MAX_LINES, maxBytes = MAX_BYTES) {
  const all = lines(s);
  const total = all.length;
  if (total <= maxLines && size(s) <= maxBytes) return { content: s, total, kept: total, truncated: false, byBytes: false };
  const kept: string[] = [];
  let bytes = 0, byBytes = false;
  if (tail) all.reverse();
  for (const line of all.slice(0, maxLines)) {
    const next = size(line) + Number(kept.length > 0);
    if (bytes + next > maxBytes) {
      byBytes = true;
      if (tail && !kept.length) {
        const buf = Buffer.from(line);
        let at = buf.length - maxBytes;
        while ((buf[at] & 0xc0) === 0x80) at++;
        kept.push(buf.toString("utf8", at));
      }
      break;
    }
    bytes += next;
    kept.push(line);
  }
  return { content: (tail ? kept.reverse() : kept).join("\n"), total, kept: kept.length, truncated: true, byBytes };
}
export function readWindow(text: string, path: string, offset?: number, limit?: number) {
  const all = lines(text), total = all.length;
  const start = Math.max(0, (offset ?? 1) - 1), end = Math.min(total, start + (limit ?? total));
  if (start >= total && (start || total)) throw new Error(`Offset ${offset ?? 0} is beyond end of file (${total} lines total)`);
  const { content, truncated, byBytes, kept } = cut(all.slice(start, end).join("\n"));
  const first = start + 1, last = start + kept;
  if (truncated && !kept) return `[Line ${first} is ${formatSize(size(all[start]))}, exceeds ${formatSize(MAX_BYTES)} limit. Use exec: sed -n '${first}p' ${path} | head -c ${MAX_BYTES}]`;
  if (truncated) return `${content}\n\n[Showing lines ${first}-${last} of ${total}${byBytes ? ` (${formatSize(MAX_BYTES)} limit)` : ""}. Use offset=${last + 1} to continue.]`;
  return end < total ? `${content}\n\n[${total - end} more lines in file. Use offset=${end + 1} to continue.]` : content;
}
export function listing(names: string[], limit: number, kind: "results" | "entries") {
  const { content, truncated } = cut(names.slice(0, limit).join("\n"), false, Infinity);
  const notices = [];
  if (names.length > limit) notices.push(`${limit} ${kind} limit reached. Use limit=${limit * 2} for more${kind === "results" ? ", or refine pattern" : ""}`);
  if (truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`);
  return notices.length ? `${content}\n\n[${notices.join(". ")}]` : content;
}
export function applyEdits(original: string, edits: readonly { oldText: string; newText: string }[], path: string) {
  if (!edits.length) throw new Error("edits must contain at least one replacement");
  const bom = original.startsWith("\ufeff") ? "\ufeff" : "";
  const body = original.slice(bom.length), crlf = body[body.indexOf("\n") - 1] === "\r";
  const lf = (s: string) => s.replace(/\r\n?/g, "\n");
  const base = lf(body);
  const spans = edits.map(({ oldText, newText }, index) => {
    const old = lf(oldText), label = edits.length === 1 ? "oldText" : `edits[${index}].oldText`;
    if (!old) throw new Error(`${label} must not be empty in ${path}.`);
    const count = base.split(old).length - 1;
    if (!count) throw new Error(`Could not find ${label} in ${path}. It must match exactly, including all whitespace and newlines.`);
    if (count !== 1) throw new Error(`Found ${count} occurrences of ${label} in ${path}. The text must be unique. Provide more context to make it unique.`);
    const start = base.indexOf(old);
    return { start, end: start + old.length, newText: lf(newText), index };
  }).sort((a, b) => a.start - b.start);
  let at = 0, result = "";
  for (const [i, span] of spans.entries()) {
    if (span.start < at) throw new Error(`edits[${spans[i - 1].index}] and edits[${span.index}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    result += base.slice(at, span.start) + span.newText;
    at = span.end;
  }
  result += base.slice(at);
  if (result === base) throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
  return bom + (crlf ? result.replace(/\n/g, "\r\n") : result);
}
