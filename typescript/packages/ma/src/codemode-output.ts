const RESULT_BYTES = 50 * 1024;
const RESULT_LINES = 2000;
export const PRINT_BYTES = 1024 * 1024;

export function utf8Prefix(bytes: Buffer, limit: number) {
  if (bytes.length <= limit) return bytes.toString();
  while (limit > 0 && (bytes[limit] & 0xc0) === 0x80) limit--;
  return bytes.toString("utf8", 0, limit);
}

// Cut even a single long line, and reserve room for the cut note.
export function bounded(text: string, more = false) {
  const bytes = Buffer.from(text);
  const lines = text.replace(/\n$/, "").split("\n");
  if (!more && bytes.length <= RESULT_BYTES && lines.length <= RESULT_LINES) return text;
  const prefix = utf8Prefix(Buffer.from(lines.slice(0, RESULT_LINES - 1).join("\n")), RESULT_BYTES - 256);
  const kept = prefix.split("\n").length;
  const total = more ? "" : ` of ${lines.length} lines (${Buffer.byteLength(prefix)} of ${bytes.length} bytes)`;
  return `${prefix}\n[Output cut: showing the first ${kept}${total}. Return or print less, or write the rest to a file.]`;
}

export class PrintedOutput {
  private chunks: string[] = [];
  private bytes = 0;
  constructor(private readonly limit: number) {}

  append(text: string) {
    const bytes = Buffer.from(text);
    const remaining = this.limit - this.bytes;
    if (bytes.length > remaining) {
      this.chunks.push(utf8Prefix(bytes, remaining));
      throw new Error(`RuntimeError: printed output exceeded ${this.limit} bytes`);
    }
    if (text) this.chunks.push(text);
    this.bytes += bytes.length;
  }

  text() { return this.chunks.join(""); }
}

// The worker sends Monty's traceback frames, in order, rather than display text.
interface Location { line: number; column: number }
interface Frame {
  filename: string; start: Location; end: Location; frameName?: string;
  previewLine?: string; hideCaret: boolean; hideFrameName: boolean;
}
export interface Raised { excType: string; message?: string; traceback?: Frame[] }
export class PythonError extends Error {
  constructor(readonly exception: Raised) {
    const frames = exception.traceback ?? [];
    let text = frames.length ? "Traceback (most recent call last):\n" : "";
    for (let i = 0; i < frames.length;) {
      const frame = frames[i];
      let end = i + 1;
      // Monty groups by file, line and function, not by expression column.
      while (end < frames.length && frames[end].filename === frame.filename &&
        frames[end].start.line === frame.start.line && frames[end].frameName === frame.frameName) end++;
      for (let j = i; j < Math.min(end, i + 3); j++) text += formatFrame(frames[j]);
      if (end - i > 3) text += `  [Previous line repeated ${end - i - 3} more times]\n`;
      i = end;
    }
    const reason = exception.excType + (Object.hasOwn(exception, "message") ? `: ${exception.message}` : "");
    super(text + reason);
  }
}

function formatFrame(frame: Frame) {
  const { start, previewLine, hideCaret, hideFrameName } = frame;
  let line = `  File "${frame.filename}", line ${start.line}${hideFrameName ? "" : `, in ${frame.frameName ?? "<module>"}`}\n`;
  if (!Object.hasOwn(frame, "previewLine") || previewLine === undefined) return line;
  if (start.line !== frame.end.line) return line + previewLine.replace(/\r?\n$/, "").split(/\r?\n/).map(s => `    ${s}\n`).join("");
  const preview = previewLine.trimStart();
  line += `    ${preview}\n`;
  if (!hideCaret) {
    const width = Math.max(1, frame.end.column - start.column);
    const offset = Math.max(0, start.column - 1 - (Buffer.byteLength(previewLine) - Buffer.byteLength(preview)));
    line += `${" ".repeat(4 + Math.min(offset, 2000))}${"~".repeat(Math.min(width, 2000))}\n`;
  }
  return line;
}
