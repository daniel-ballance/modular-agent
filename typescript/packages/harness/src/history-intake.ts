import { isDeepStrictEqual } from "node:util";
import type { Session } from "./session.js";
import type { HistoryEntry } from "./types.js";

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const authority = (data: Record<string, unknown>) => Array.isArray(data.rights) && data.rights.every(id) &&
	Array.isArray(data.authorizers) && data.authorizers.every(a => object(a) && id(a.sessionId) &&
		(id(a.actorId) && !Object.hasOwn(a, "jobId") || id(a.jobId) && !Object.hasOwn(a, "actorId")));

/** Validate retained work before authorizing attachment or recovering any effects. */
export function validateRetainedWork(session: Session): void {
	const jobs = new Map<string, HistoryEntry>();
	const reports = new Map<string, HistoryEntry>();
	const earlier = new Set<string>();
	for (const entryId of session.order) {
		const entry = session.entries.get(entryId)!;
		const { data, jobId, kind } = entry;
		const malformed = () => new Error(`Malformed ${kind} history record: ${entryId}`);
		if (kind === "position") {
			if (entry.erased || !object(data) || data.failed === true ||
				data.to !== null && (!id(data.to) || !earlier.has(data.to) || session.entries.get(data.to)?.kind === "position") ||
				Object.hasOwn(data, "restore") && (!object(data.restore) || !id(data.restore.point) || !id(data.restore.undo))) throw malformed();
		}
		earlier.add(entryId);
		if (session.copied.has(entryId)) continue;
		if (!entry.erased && kind === "inputAccepted" && (!id(entry.actorId) || !object(data) || !authority(data))) throw malformed();
		if (kind === "jobStarted" && jobId) jobs.set(jobId, entry);
		if (kind === "jobEnded" && !entry.erased) {
			if (!jobId || !jobs.has(jobId) || !object(data) || typeof data.report !== "boolean") throw malformed();
			if (data.report) {
				if (reports.has(jobId) || !Array.isArray(data.result)) throw malformed();
				reports.set(jobId, entry);
			}
		}
		if (kind === "inputAccepted" && jobId && reports.has(jobId) &&
			(entry.erased || object(data) && !Object.hasOwn(data, "releasedBy"))) {
			const end = reports.get(jobId)!;
			const start = jobs.get(jobId)!;
			if (!entry.erased && (!object(data) || data.key !== `job:${jobId}` || data.when !== "after" ||
				!isDeepStrictEqual(data.content, (end.data as { result: unknown }).result) ||
				!start.erased && entry.actorId !== start.actorId)) throw malformed();
			reports.delete(jobId);
		}
	}
	if (reports.size) throw new Error("Missing admission for a retained job report");
}
