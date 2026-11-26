import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Agent, Answer, Event, Session, ToolCall, ToolStatus } from "@modular-agent/core";

const SESSION_COMMANDS = ["/compact", "/skills"];

function sink(json: boolean, verbose: boolean, stream: boolean) {
  let midline = false;
  const calls = new Map<string, boolean>();
  const flush = () => { if (midline) process.stdout.write("\n"); midline = false; };
  const show = (line: string) => { flush(); console.error(line); };
  return { flush, show, event(e: Event) {
    if (json) { console.log(JSON.stringify(e)); return; }
    if (stream && e.type === "text") {
      process.stdout.write(e.data.delta);
      if (e.data.delta) midline = !e.data.delta.endsWith("\n");
    }
    if (e.type === "toolStarted") {
      const { call } = e.data as { call: ToolCall };
      const nested = call.startedBy === "tool";
      calls.set(call.id, nested);
      const input = Object.entries(call.input ?? {}).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
      const small = [...input].length > 200 ? [...input].slice(0, 200).join("") + "..." : input;
      if (nested && verbose) show(`  -> ${call.name}(${small})`);
      else if (!nested && call.name === "codemode") show("codemode\n" + String(call.input.code).trimEnd().split("\n").map(l => `  | ${l}`).join("\n"));
      else if (!nested) show(`${call.name}(${small})`);
    }
    if (e.type === "toolOutput" && verbose) {
      flush();
      const p = e.data as { content?: { type: string; text?: string }[] };
      process.stderr.write(p.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("") ?? "");
    }
    if (e.type === "toolResult") {
      const d = e.data as { callId: string; status: ToolStatus; content?: { type: string; text?: string }[] };
      const nested = calls.get(d.callId);
      calls.delete(d.callId);
      if (d.status && d.status !== "completed" && (!nested || verbose)) {
        const line = d.content?.flatMap(c => c.type === "text" ? c.text?.split("\n") ?? [] : []).find(l => l.trim()) ?? "";
        show(`${nested ? "     " : "  "}${d.status}: ${line}`);
      }
    }
    if (e.type === "turnEnded") { flush(); if (e.data.outcome.kind === "failed") show(e.data.outcome.error); }
  } };
}
export async function print(session: Session, prompt: string, json: boolean, verbose: boolean) {
  const out = sink(json, verbose, false);
  if (!json) console.error(`Session ${session.id}`);
  let complete = false;
  for await (const event of session.promptStream(prompt)) {
    out.event(event);
    if (event.type === "turnEnded") {
      complete = event.data.outcome.kind === "completed";
      if (!json) console.log(event.data.result.text ?? "");
    }
  }
  return complete ? 0 : 1;
}
/** Readline echoes what is typed through its output, so muting the output hides a secret. */
function mutable() {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (muted) done(); else process.stderr.write(chunk, encoding, done); } });
  Object.defineProperty(output, "columns", { get: () => process.stderr.columns });
  return { output, mute(on: boolean) { muted = on; } };
}
export async function line(agent: Agent, session: Session, json: boolean, verbose: boolean, input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin) {
  const tty = !!input.isTTY, echo = mutable();
  const io = createInterface({ input, output: echo.output, terminal: tty });
  let secretFor: string | undefined;
  io.on("history", (history: string[]) => { if (secretFor !== undefined) history.shift(); });
  const out = sink(json, verbose, true);
  const waiting = new Map<string, { kind: string; answer(answer: Answer): void }>();
  const approvals = new Map<string, { display: string; answer(a: Answer): void }>();
  const firstApproval = () => approvals.values().next().value;
  if (!json) console.error(`Session ${session.id}`);
  const watch = (async () => {
    try { for await (const e of session.events((await session.history()).at(-1)?.id)) {
      out.event(e);
      if (e.type === "turnEnded" && !json && tty) io.prompt();
    } } catch (error) { out.show((error as Error).message); }
  })();
  let eof = false;
  session.onQuestion((q, ctx) => new Promise(resolve => {
    if (eof || (q.kind === "secret" && !tty)) { resolve("decline"); return; }
    const answer = (a: Answer) => {
      const first = firstApproval();
      waiting.delete(q.id); approvals.delete(q.id); resolve(a);
      if (!eof && first?.answer === answer && firstApproval()) out.show(firstApproval()!.display);
    };
    waiting.set(q.id, { kind: q.kind, answer });
    ctx.cancelled.addEventListener("abort", () => answer("decline"), { once: true });
    if (q.kind === "approval" && q.call) {
      const display = `${q.question}\n${q.call.name} ${JSON.stringify(q.call.input, null, 2)}\nAllow? (y/n)`;
      approvals.set(q.id, { display, answer });
      if (approvals.size === 1) out.show(display);
      return;
    }
    out.show(`Question ${q.id}: ${q.question}${q.options?.length ? " " + JSON.stringify(q.options) : ""}\nUse /answer REQUEST_ID ${q.kind === "secret" ? "(hidden input)" : "VALUE"}`);
  }));
  const endSecret = () => { secretFor = undefined; echo.mute(false); process.stderr.write("\n"); };
  const cancel = () => {
    if (secretFor !== undefined) {
      waiting.get(secretFor)?.answer("decline");
      io.write(null, { ctrl: true, name: "e" }); io.write(null, { ctrl: true, name: "u" });
      endSecret();
    }
    void session.cancel().catch(error => out.show((error as Error).message));
  };
  io.on("SIGINT", cancel);
  process.on("SIGINT", cancel);
  const models = () => agent.models().map(m => `${m.provider}/${m.id}`);
  const say = (text?: string | void) => { if (text) console.log(text); };
  try {
    if (!json && tty) io.prompt();
    for await (const input of io) {
      if (secretFor !== undefined) {
        const question = waiting.get(secretFor);
        endSecret();
        if (question) question.answer({ value: input });
        else out.show("question is no longer answerable");
        continue;
      }
      const line = input.trim();
      const approval = firstApproval();
      if (!line && !approval) continue;
      const [word = "", value = ""] = /^([\S]+)(?:\s+(.*))?$/.exec(line)?.slice(1) ?? [];
      try {
        if (line === "/cancel") cancel();
        else if (approval) {
          if (/^[yn]$/i.test(line)) approval.answer(line.toLowerCase() === "y" ? "allow" : "decline");
          else out.show("Answer y or n.");
        }
        else if (line === "/quit") { await session.cancel(); break; }
        else if (word === "/after") { if (value) await session.send(value, "after"); }
        else if (word === "/answer") {
          const split = value.indexOf(" ");
          const id = split < 0 ? value : value.slice(0, split), given = split < 0 ? undefined : value.slice(split + 1);
          const question = waiting.get(id);
          if (!question) throw new Error(`no question named ${id}`);
          if (given === "decline") question.answer("decline");
          else if (question.kind === "secret") {
            if (given !== undefined) throw new Error("Do not put the secret on the command line; use /answer REQUEST_ID");
            secretFor = id;
            process.stderr.write("Secret: ");
            echo.mute(true);
          } else if (given === undefined) throw new Error("use /answer REQUEST_ID VALUE");
          else question.answer({ value: given });
        } else if (line === "/questions") {
          say(JSON.stringify([...waiting.keys()]));
        } else if (line === "/commands") {
          say(["/after", "/answer", "/cancel", "/commands", "/model", "/questions", "/quit", "/skill:NAME", "/thinking", ...SESSION_COMMANDS].sort().join("\n"));
        } else if (word === "/model") {
          if (value) await session.setSetting("model", value);
          else say(models().join("\n"));
        } else if (word === "/thinking") {
          if (value) await session.setSetting("thinking", value);
          else say(String(session.settings().reasoning ?? "off"));
        } else if (SESSION_COMMANDS.includes(word)) say(await session.runCommand(input));
        else if (word.startsWith("/") && !word.startsWith("/skill:")) throw new Error(`Unknown command ${word}`);
        else await session.send(input, "steer");
      } catch (err) { out.show((err as Error).message); }
    }
    eof = true;
    for (const { answer } of waiting.values()) answer("decline");
    await session.waitIdle();
  } finally {
    echo.mute(false);
    process.off("SIGINT", cancel);
    io.close();
    await session.close();
    await watch;
    out.flush();
  }
  return 0;
}
