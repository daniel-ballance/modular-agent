# History service binding: `modular-agent-history/1`

A history store as an HTTP service, so an agent in one language can keep its sessions in a service written in another. The service doesn't read entries. It keeps them, in order, and gives them back. So any agent can use any service that follows this binding.

## The basics

- **Authentication:** every request carries `Authorization: Bearer <token>`. A missing or wrong token gets `401`.
- **Bodies:** requests and responses are JSON.
- **Errors:** an error is `{ "error": "<message>", "code": "<code>" }`, with the HTTP status given below.
- **Safe to resend:** every request is safe to send again. If an answer is lost, the client sends the same request again and gets the same effect. This is how the binding keeps the contracts' rule that keeping the same entries twice keeps them once.
- **Version:** `GET /v1` answers `{ "binding": "modular-agent-history/1" }`.

## Sessions

| Request | Body | Answer |
|---|---|---|
| `PUT /v1/sessions/{id}` | `{ "project": string, "created": number, "parentSessionId"?: string, "forkedFrom"?: { "sessionId", "entryId" } }` | `200 {}`. Sending the same session again is harmless. The same id with a different `project` is `409 conflict`. |
| `GET /v1/sessions?project={path}` | | `200 { "sessions": [Session] }`, newest first. Without `project`, every project's. A session with no kept entries is not listed. |
| `GET /v1/sessions/{id}` | | `200 { "session": Session, "entries": [Entry] }` in the order they were kept. `?after={entryId}` gives only the entries after that one, and an unknown entry is `404 unknown_entry`. An unknown session is `404 unknown_session`. |

A Session is the body of the `PUT`, plus its `id`.

The service lists whatever has entries. Keeping "a session started only to look leaves nothing behind" is the agent's job: it sends a session only once something happens in it beyond setup, such as its first input. A client that sends every setting at once breaks that rule through the service. The TypeScript build did, until the ACP conformance kit caught it.

## Writing: one writer at a time

Only one writer may add entries to a session at a time. A writer holds a **lease** on the session, and the service ends it if the writer stops renewing it.

| Request | Body | Answer |
|---|---|---|
| `POST /v1/sessions/{id}/lease` | `{ "owner": string }` | `200 { "lease": string, "ttlMs": number }`. If the same owner already holds a lease, the same lease is returned. Another owner's lease that hasn't run out gives `409 held`. |
| `POST /v1/sessions/{id}/lease/{lease}/renew` | | `200 { "ttlMs": number }`. A lease that ran out, or was released, gives `409 lost`. |
| `DELETE /v1/sessions/{id}/lease/{lease}` | | `200 {}`. Releasing twice is harmless. |

The owner is a string the writer picks once per run, so the service can tell writers apart. The writer renews its lease at intervals of at most a third of `ttlMs`. A writer whose lease is lost stops writing; it doesn't quietly take a new lease.

## Entries

| Request | Body | Answer |
|---|---|---|
| `POST /v1/sessions/{id}/entries` | `{ "lease": string, "entries": [Entry] }` | `200 { "kept": number }` |

- **All or none.** The service keeps all the entries in the request, or none of them.
- **Resending is harmless.** An entry whose `id` is already kept, with the same content, is skipped. `kept` counts only the new ones.
- **The same `id` with different content** gives `409 conflict`, and nothing is kept.
- **The lease must be current.** Otherwise the answer is `409 lost`, and nothing is kept.

An Entry is a JSON object with at least `id`, a string unique in its session, and `parentId`, a string or null. The service keeps every other field exactly as given, and returns it unchanged. Two entries have the same content when their JSON is equal, ignoring the order of object keys.

## Erasure

| Request | Body | Answer |
|---|---|---|
| `POST /v1/sessions/{id}/erase` | `{ "entryIds": [string], "lease"?: string }` | `200 { "erased": [string] }` |

- **What remains of an erased entry** is only `{ "id", "parentId", "kind", "erased": true }`. Every other field is removed, in every place the service keeps it.
- **Erasing an entry again is harmless.**
- **If another owner holds a current lease on the session,** and the request doesn't carry that lease, the answer is `409 held`, and nothing is erased.
- **Which entries to erase is the agent's decision.** The service doesn't follow copies; the agent works out what to erase from its own contracts and lists every entry.

## What the service declares

`GET /v1` may also return:
- `ttlMs`, the default lease length;
- `retention`, how long sessions are kept, or null for no limit.
