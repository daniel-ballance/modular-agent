import { randomUUID } from "node:crypto";
import type { WaitingSummary } from "@modular-agent/harness";
import type { AguiBinding } from "./agui.js";
import { fail, same } from "./agui-wire.js";
import { reply, type Principal } from "./agui-view.js";

type Thread = { threadId: string; updatedAt: string; waiting: WaitingSummary };
type Position = Pick<Thread, "updatedAt" | "threadId">;
const compare = (a: Position, b: Position) => b.updatedAt.localeCompare(a.updatedAt) || a.threadId.localeCompare(b.threadId);

export class ThreadListing {
  // A cursor identifies a position, not a saved page or an authorization decision.
  private cursors = new Map<string, Position & { clientId: string; expires: number }>();

  async page(query: URLSearchParams, binding: AguiBinding, p: Principal) {
    const raw = query.get("limit") ?? "100";
    const limit = Number(raw);
    if (!/^\d+$/.test(raw) || limit < 1 || limit > 500 || query.getAll("limit").length > 1 || query.getAll("after").length > 1) fail("invalid_request");
    const after = this.cursors.get(query.get("after") ?? "");
    if (query.has("after") && (!after || after.clientId !== p.clientId || after.expires <= Date.now())) fail("invalid_request");

    const { host } = binding, tenant = host.tenant ?? null;
    const inspect = async (id: string): Promise<Thread | undefined> => {
      const { agent } = host.owner(id);
      const presence = binding.clients.get(JSON.stringify([p.clientId, id]))?.presence;
      const listing = await agent.sessionSummary(id, { actor:{ ...p.actor, rights:p.actor.authority }, routeId:p.clientId,
        scope:(project, name) => project === host.project && (name ?? null) === tenant && p.allowProject(project) && p.allowTenant(tenant),
        inTurn:presence && !presence.response.destroyed ? [...presence.questions] : [] }).catch(error => {
          if (error.code !== "unavailable" && error.code !== "not_found") throw error;
          // Pending erasure, or a thread removed since enumeration.
          return undefined;
        });
      if (listing && listing.project === host.project && (listing.tenant ?? null) === tenant) {
        return { threadId:id, updatedAt:new Date(listing.updated).toISOString(), waiting:listing.waiting };
      }
    };
    const candidates: Thread[] = [];
    if (p.actor.authority.includes("watch") && p.allowProject(host.project) && p.allowTenant(tenant)) {
      for (const meta of await host.root.api.listSessions(host.project)) {
        if (meta.project !== host.project) continue;
        const row = await inspect(meta.id);
        if (row && (!after || compare(row, after) > 0)) candidates.push(row);
      }
    }
    const visible: Thread[] = [];
    for (const row of candidates.sort(compare)) {
      const api = host.owner(row.threadId).api;
      try {
        if (!same(row, await reply(api, row.threadId, p, "thread", structuredClone(row)))) continue;
      } catch (error) {
        if (["output_withheld", "unavailable"].includes((error as {code:string}).code)) continue;
        throw error;
      }
      visible.push(row);
      if (visible.length > limit) break;
    }
    const threads = visible.slice(0, limit);
    const next = visible.length > limit ? randomUUID() : undefined;
    const page = { threads, ...(next && { next }) };
    if (!same(page, await reply(host.root.api, "", p, "threads", structuredClone(page)))) fail("output_withheld");
    // Output gates can wait. Never send a stale grant or count after that wait.
    const current: Thread[] = [];
    for (const row of threads) if (same(row, await inspect(row.threadId))) current.push(row);
    if (next) {
      if (this.cursors.size >= 4096) this.cursors.delete(this.cursors.keys().next().value!);
      const { threadId, updatedAt } = threads.at(-1)!;
      this.cursors.set(next, { threadId, updatedAt, clientId:p.clientId, expires:Date.now() + 300_000 });
    }
    return { ...page, threads:current };
  }
}
