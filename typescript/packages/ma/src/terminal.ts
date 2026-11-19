import { createInterface } from "node:readline";
import type { Agent, Answer, Event, Session, ToolCall, ToolStatus } from "@modular-agent/core";

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
      const call = e.data as ToolCall;
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
export async function line(agent: Agent, session: Session, json: boolean, verbose: boolean) {
  const io = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
  const out = sink(json, verbose, true);
  const waiting = new Map<string, (answer: Answer) => void>();
  const abort = new AbortController();
  if (!json) console.error(`Session ${session.id}`);
  const watch = (async () => {
    try { for await (const e of session.events((await session.history()).at(-1)?.id)) {
      if (abort.signal.aborted) break;
      out.event(e);
      if (e.type === "turnEnded") { if (!json && process.stdin.isTTY) io.prompt(); }
    } } catch (error) { if (!abort.signal.aborted) out.show((error as Error).message); }
  })();
  session.onQuestion((q, ctx) => new Promise(resolve => {
    const answer = (a: Answer) => { waiting.delete(q.id); resolve(a); };
    waiting.set(q.id, answer);
    ctx.cancelled.addEventListener("abort", () => answer("decline"), { once: true });
    out.show(`Question ${q.id}: ${q.question}${q.options ? " " + JSON.stringify(q.options) : ""}\nUse /answer REQUEST_ID VALUE`);
  }));
  const cancel = () => { void session.cancel().catch(error => out.show((error as Error).message)); };
  io.on("SIGINT", cancel);
  process.on("SIGINT", cancel);
  let turn: Promise<unknown> | undefined;
  const models = () => agent.models().map(m => `${m.provider}/${m.id}`);
  const say = (text?: string | void) => { if (text) console.log(text); };
  try {
    if (!json && process.stdin.isTTY) io.prompt();
    for await (const input of io) {
      if (!input.trim()) continue;
      const [word, value = ""] = /^([\S]+)(?:\s+(.*))?$/.exec(input.trim())?.slice(1) ?? [];
      try {
        if (word === "/cancel") cancel();
        else if (word === "/after") { if (value) await session.send(value, "after"); }
        else if (word === "/answer") {
          const split = value.indexOf(" ");
          const id = split < 0 ? value : value.slice(0, split);
          const answer = waiting.get(id);
          if (!answer) throw new Error(`no question named ${id}`);
          answer(split < 0 ? "decline" : { value: value.slice(split + 1) });
        } else if (word === "/commands") {
          say(["/commands", "/model [PROVIDER/ID]", "/thinking [LEVEL]", "/after TEXT", "/cancel", "/skill:NAME", ...session.commands().map(c => `/${c.name}  ${c.description}`)].join("\n"));
        } else if (word === "/model") {
          if (value) await session.setSetting("model", value);
          else say(models().join("\n"));
        } else if (word === "/thinking") {
          if (value) await session.setSetting("thinking", value);
          else say(String(session.settings().reasoning ?? "off"));
        } else if (word.startsWith("/") && !word.startsWith("/skill:")) say(await session.runCommand(input));
        else if (turn) await session.send(input, "steer");
        else {
          turn = session.prompt(input).catch(error => out.show((error as Error).message)).finally(() => { turn = undefined; });
        }
      } catch (err) { out.show((err as Error).message); }
      if (process.stdin.isTTY && !turn && !json) io.prompt();
    }
    for (const answer of waiting.values()) answer("decline");
    await turn;
  } finally {
    abort.abort();
    process.off("SIGINT", cancel);
    io.close();
    await session.close();
    await watch;
    out.flush();
  }
  return 0;
}
