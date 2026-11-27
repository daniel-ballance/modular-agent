import type { HistoryCommit } from "./history-commit.js";
import type { Session } from "./session.js";
import type { HistoryStore, StoredSession } from "./types.js";

/** A fork's first append publishes both its session and its retained records.
 * Stage create/open locally until that append fits the ledger. This works even
 * for stores where create() immediately publishes the session metadata. */
export function lifecycleHistory(
	use: <T>(capability: string) => T | undefined,
	commit: () => HistoryCommit,
	session: (id: string) => Session,
): <T>(capability: string) => T | undefined {
	const adapters = new WeakMap<HistoryStore, HistoryStore>();
	return <T>(capability: string) => {
		if (capability !== "history-store") return use<T>(capability);
		const store = use<HistoryStore>(capability);
		if (!store) return undefined;
		let adapter = adapters.get(store);
		if (!adapter) {
			const staged = new Map<string, StoredSession>();
			adapter = {
				supports: store.supports,
				pendingErasure: store.pendingErasure,
				historyErasure: store.historyErasure,
				async create(meta) {
					if (meta.forkedFrom) staged.set(meta.id, meta);
					else await store.create(meta);
				},
				async openForWriting(id, options) {
					if (!staged.has(id)) await store.openForWriting(id, options);
				},
				async close(id) {
					if (!staged.delete(id)) await store.close(id);
				},
				async append(id, batch, options) {
					const meta = staged.get(id);
					if (!meta) return store.append(id, batch, options);
					commit().reserveFork(session(id), batch);
					staged.delete(id);
					await store.create(meta);
					await store.openForWriting(id);
					await store.append(id, batch, options);
				},
				writerActive: store.writerActive?.bind(store),
				writerSignal: id => staged.has(id) ? undefined : store.writerSignal?.(id),
				checkWriter: id => { if (!staged.has(id)) store.checkWriter?.(id); },
				load: store.load.bind(store),
				erasureTenant: store.erasureTenant?.bind(store),
				list: store.list.bind(store),
				erase: store.erase?.bind(store),
			};
			adapters.set(store, adapter);
		}
		return adapter as T;
	};
}
