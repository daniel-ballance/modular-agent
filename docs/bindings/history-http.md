# History service binding: `modular-agent-history/1`

An HTTP history store. The service keeps JSON records in order. It does not interpret agent history. Reopening another build's session is a promise between agents that declare [portable sessions](data.md#portable-sessions), not a property of the store.

## The basics

- The service MUST authenticate every request, including `GET /v1`, using a bearer token with at least 128 bits of entropy or mutual TLS. A bearer token MUST be sent as `Authorization: Bearer <token>` and compared in constant time.
- Clients and services MUST use TLS except on loopback. TLS peers MUST verify the identity of the other party they authenticate. A client MUST NOT forward credentials to a redirect target. Clients and services MUST NOT log credentials or lease values, including lease values in URLs.
- One credential authorizes the whole service, including listing, raw reads, writes and erasure. A project filter is not an access boundary. Operators who need isolation between tenants or agents MUST use separate services with separate credentials.
- A nonempty body MUST be one UTF-8 JSON object with media type `application/json`, using the [shared JSON rules](data.md#general-rules). Responses MUST use that media type, including errors and `{}`. The service MUST reject request bodies over 64 MiB, measured in decoded body bytes.
- The client MUST percent-encode each path parameter as one UTF-8 segment and each query value as one UTF-8 value, leaving only RFC 3986 unreserved bytes unescaped. The service MUST decode exactly once without converting `+` to space or treating a decoded slash as a path separator. The service MUST reject invalid encoding, unknown or repeated query parameters, and queries on endpoints that do not list parameters.
- The service MUST check errors in this order: authentication, route, method, size, media type, request shape, session existence, then the operation's preconditions. An error response MUST leave session state unchanged. If the service cannot tell whether a mutation committed, it MUST close the request without a success or error response.

The two tables are the request and response definitions. `?` means optional; an omitted query has the default shown in the table. Where the table says none, the client MUST omit that query or body.

| Method and path | Query fields | Body |
|---|---|---|
| `GET /v1` | none | none |
| `PUT /v1/sessions/{id}` | none | Session metadata (below) without `id`; the service MUST reject a body containing `id` |
| `GET /v1/sessions` | `project?`: string (default all projects); `after?`: session ID (default start); `limit?`: integer 1 to 500 (default 500) | none |
| `GET /v1/sessions/{id}` | `after?`: entry ID (default start); `limit?`: integer 1 to 500 (default 500) | none |
| `POST /v1/sessions/{id}/lease` | none | `{ owner: Id }` |
| `POST /v1/sessions/{id}/lease/{lease}/renew` | none | none |
| `DELETE /v1/sessions/{id}/lease/{lease}` | none | none |
| `POST /v1/sessions/{id}/entries` | none | `{ lease: Id, entries: Entry[] }` |
| `POST /v1/sessions/{id}/erase` | none | `{ entryIds: Id[], lease?: Id }` (no lease by default) |

The service MUST return the status and body shown for each case. All errors MUST have `{ error: string, code: string }`, with `retryAfterMs` added as shown for `held`. The message is for humans; the code is for clients.

| Request or case | Status and body |
|---|---|
| `GET /v1` | `200 { binding: "modular-agent-history/1", ttlMs: PositiveMs, retention?: PositiveMs \| null }` |
| `PUT /v1/sessions/{id}`, new or identical | `200 {}` |
| `PUT /v1/sessions/{id}`, different metadata or previously expired ID | `409 conflict` |
| `GET /v1/sessions` | `200 { sessions: Session[], next?: Id }` |
| `GET /v1/sessions/{id}` | `200 { session: Session, entries: Entry[], next?: Id }` |
| List cursor not in the requested list | `404 unknown_session` |
| Entry cursor not in the requested session | `404 unknown_entry` |
| Acquire, granted or already held by this owner | `200 { lease: Id, ttlMs: PositiveMs }` |
| Renew current lease | `200 { ttlMs: PositiveMs }` |
| Release, whether current or stale | `200 {}` |
| Append, including a batch with no new entries | `200 { kept: Count }` |
| Append with a conflicting entry ID | `409 conflict` |
| Append with an entry that cannot fit a page | `413 entry_too_large` |
| Erase | `200 { erased: Id[] }` |
| Acquire held by another owner, or erase without a lease while held | `409 { error: string, code: "held", retryAfterMs: PositiveMs }` |
| Renew, append or erase with a supplied lease that is not current | `409 lost` |
| Any operation on an unknown or expired session, except PUT | `404 unknown_session` |
| Missing or invalid authentication | `401 unauthorized`; a service accepting bearer tokens MUST include `WWW-Authenticate: Bearer` |
| Unknown path | `404 not_found` |
| Unlisted method on a known path | `405 method_not_allowed`, with the allowed methods in `Allow` |
| Request body over the size limit or metadata too large for the read envelope | `413 request_too_large` |
| Unsupported media type for a nonempty body | `415 unsupported_media_type` |
| Invalid JSON, field, path or query value, missing required body, body where none is allowed, or an appended tombstone | `400 invalid_request` |
| Temporary service or storage failure | `503 unavailable` |

`Id` and `Count` use the [shared types](data.md#general-rules). `PositiveMs` is a positive `Count` in milliseconds. An omitted `next` means there are no more results at the time of that read. A successful response MUST omit fields not in its shape, except unknown metadata and entry fields the service keeps.

## Sessions

A Session is `{ id: Id, project: string, created: Time, parentSessionId?: Id, forkedFrom?: { sessionId: Id, entryId: Id } }`. The two optional fields default to absent. Session metadata uses [shared time and equality](data.md#general-rules); project paths are compared as exact strings. The service MUST preserve unknown metadata fields and compare the entire metadata object on repeated PUT. It MUST NOT dereference or authorize lineage separately. The Harness is responsible for lineage and [tenant authorization](data.md#limits-and-tenants).

The service MUST list sessions with kept entries only, by descending `created`, then by ascending UTF-8 byte order of `id`. It MUST apply `project` before finding the cursor or taking a page. It MUST return session entries in append order. Each page MUST take the longest prefix after the cursor that fits the requested item limit and 4 MiB of compact UTF-8 response JSON, including all metadata and the cursor. A page MUST contain at least one item when any remain. If more remain, `next` MUST be the ID of the last item; the client passes it as `after` on the next request. Reads need no lease and do not take a snapshot across pages.

The agent MUST defer PUT and append for a new session until its [first admitted input](data.md#portable-sessions). A failure between PUT and that append can leave an unlisted metadata-only record. There is no endpoint to delete that record.

## Choosing a service at start

An agent that supports this binding MUST read these variables at startup:
- `MODULAR_AGENT_HISTORY_URL`: the base URL, without the `/v1` path.
- `MODULAR_AGENT_HISTORY_TOKEN_FILE`: the path to a UTF-8 bearer token file. The client MUST strip surrounding whitespace and use the rest verbatim. An empty token or an unreadable file is a configuration error. A configured service URL without usable bearer or mTLS credentials is a configuration error.

When configured, the client MUST use this URL in preference to its local store. Operators SHOULD restrict the token file to the agent's account. The binding does not prescribe credential rotation or mTLS provisioning.

## Writing: one writer at a time

The service MUST apply each operation atomically with respect to other operations on that session, including across replicas. It MUST acknowledge a successful metadata, append or erase mutation only after durable commit. A read MUST see either the entire committed change or none of it. A service restart MUST preserve committed records and invalidate every lease.

An owner is a run identifier, not a credential. A writer MUST generate a fresh owner per run with at least 122 random bits or equivalent uniqueness. The service MUST scope ownership to the authenticated identity and session. Every new lease MUST have a fresh, unguessable value with at least 128 bits of entropy.

| State at the operation | Operation | Required transition |
|---|---|---|
| No current lease | Acquire | The service MUST make a new lease current, expiring one full `ttlMs` after grant. |
| Current lease for this owner and identity | Acquire | The service MUST return the same lease and full `ttlMs` without extending expiry. |
| Current lease for another owner or identity | Acquire | The service MUST refuse the acquire as `held`. |
| Current lease named by its authenticated writer | Renew | The service MUST set expiry to one full `ttlMs` after renewal. |
| Current lease named by its authenticated writer | Release | The service MUST end that lease. |
| Expiry reached or service restarted | Any | The service MUST treat that lease as no longer current. |
| A lease is no longer current or belongs to another identity | Renew, append or erase naming it | The service MUST refuse the operation as `lost`. |
| A lease is no longer current or belongs to another identity | Release naming it | The service MUST return success without changing state. |

The service MUST measure expiry with its monotonic clock. On `held`, it MUST report the remaining time rounded up to milliseconds when it forms the response. An ended lease MUST NOT become valid again.

The writer MUST renew at least every `ttlMs / 3`. If no renewal has succeeded within `ttlMs / 2` of the last success (initial acquire or renewal), or if a request reports `lost`, the writer MUST treat the lease as lost. A retry of acquire after a lost reply MUST be followed by a successful renew before use; acquire by the same owner does not prove a fresh expiry. The writer SHOULD time its local renewal and loss deadlines from sending the successful request, not from receiving its reply. It MUST NOT replay an old acquire after ending or declaring that lease lost. A delayed reply for a lease already treated as lost MUST NOT re-enable writes or effects. The writer MUST follow [persistence before effects](data.md#recording-order-and-ownership); the lease does not fence outside services.

An agent reopening a held session MUST retry no earlier than `retryAfterMs`, and fail the open if it cannot acquire by `GET /v1`'s `ttlMs` plus 1,000 milliseconds after the first `held`. It MUST read and reconcile the session under the new lease before recovering work. An append or erasure resend MUST use the same still-current lease. After loss or an uncertain lease the client MUST reconcile by reading rather than blindly resending. Lease-less erasure is a single atomic operation, not a retry across an intervening writer.

## Entries

For this service an Entry is any JSON object with `id: Id` and `parentId: Id | null`. The `erased: true` marker is reserved for service-created tombstones. The service MUST reject it on append. Other fields are opaque. The service MUST preserve and return those fields using [shared JSON equality](data.md#general-rules). It MUST NOT validate graph relationships or interpret kinds, authority or cross-session copies.

The service MUST validate the whole batch before committing and check the lease at the same atomic operation as the append. It MUST process entries in array order, skipping equal entries with the same ID already kept or staged in this batch. A different entry with an ID already kept or staged MUST conflict, including an original entry whose ID now holds a tombstone. `kept` counts newly appended entries. An empty batch has no effect and returns `kept: 0` under the current lease. Session IDs and entry IDs within a session MUST NOT be reused, including after erasure or retention.

The service MUST reject a new entry if that entry or its eventual tombstone, alone with session metadata and its own ID as `next`, would exceed the page limit. It MUST reject metadata that would not fit alone in a list page with its own ID as `next`, or in an empty session page.

## Erasure

The Harness MUST authorize erasure, exclude authority and accounting records, and compute all copies to erase before sending exact IDs for each session. The service MUST check the lease and tombstone the requested records in one atomic operation. Without a lease it MUST erase only when no lease is current. A supplied stale lease gives `lost` even if the session is now unheld or another writer holds it.

The service MUST return distinct known IDs from the request in first occurrence order, including IDs already erased. Unknown IDs are ignored. It MUST replace each erased record with the [shared tombstone](data.md#history-entries), using `kind: null` when the old `kind` is missing or not a string and retaining only string-valued associations. The service MUST remove the other fields from its live copies. It MUST NOT serve pre-erasure data after a restart or restore.

The Harness MUST keep a durable erasure intent before sending the deletion, and reconcile pending targets by reading if a commit or reply is uncertain. The agent, not the service, records the `erasure` entries. Per-session atomicity does not extend to copies in other sessions or to offline backups; the deployment's erasure policy governs backup deletion.

## What the service declares

The client MUST check `GET /v1` before using the service and refuse a binding it does not speak. `ttlMs` is the full lease length; the service MUST use that value for grants and renewals. If `retention` is absent or null there is no automatic expiry. Otherwise it measures milliseconds since the last commit that changed session metadata or entries, including erasure. The service MUST NOT expire a session with a current lease. Once expired, the session and its cursors are unknown, but its ID remains reserved. Retention is not an erasure acknowledgment or a reset of tenant usage.

## Changes

- **Production edition.** Defines the request and response shapes, paging, authentication, lease generations, durable writes and fenced erasure. The binding remains `modular-agent-history/1`.

- **2026-11-18, round five.** An erased entry keeps its `turnId`, `stepId`, `toolCallId` and `jobId`, as the [shared data](data.md#history-entries) now says. They are identities, not content.
- **2026-11-18, round four.** `409 held` carries `retryAfterMs`, and an agent reopening a session after a crash waits for the old lease to run out. Both the TypeScript and Go agents failed the ACP kit's crash check on a history service: the killed process still held the lease, and the new one was refused. Reopening another agent's session is promised between agents that declare portable sessions.
- **2026-11-17, after round two.** Clarifications from the Go build's binding gaps, which the TypeScript service also follows:
  - `400 invalid_request`;
  - a resend has the same effect but answers `kept: 0`;
  - what is in scope;
  - `404 unknown_session` before a `PUT`;
  - leases end when the service restarts;
  - equal numbers;
  - erased entries can't be restored, and their `kind` may be null;
  - which ids `erased` lists, and that erasure is atomic per session.
