# Share sessions between agents

Run one history service. Let one agent start a session and another take over, without copying files or running the first agent's code.

## Serve a history store

Start with a new directory for the service. Use a file-backed store so the history can survive the service itself restarting. Don't point it at a native history directory expecting an import: some SDKs use a separate namespace for served records. See [Services](../placement.md#services) and the [history service binding](../../bindings/history-http.md).

On a trusted development host, create a private token file. The service and the agents need the same token. For example, in a fresh private directory:

```sh
umask 077
openssl rand -hex 32 > history.token
```

Use a numeric loopback address such as `127.0.0.1:39071`. Plain HTTP is only for loopback on a host where you trust every local account. Use verified TLS for other deployments; do not expose these plaintext listeners. The token gives access to the history store, not to just one session. Keep it out of source, logs and prompts. See [Authentication on each wire](../../security.md#authentication-on-each-wire).

Run the following helper in the service process. Rust's future runs until stopped; if the same process also uses the blocking HTTP client, run the service on a separate task on a multi-thread Tokio runtime. A separate service process avoids sharing that runtime.

TypeScript returns a handle with `url` and `close()`. The [Rust](../../../rust/crates/sdk/tests/guide09.rs) and [TypeScript](../../../typescript/packages/core/test/guide09.test.ts) tests call these same helpers on loopback with a temporary store and a test token. See those files for imports and service startup. TypeScript applications import from `@modular-agent/core` and `@modular-agent/core/testing`.

**Rust**

```rust
async fn serve_store(address: SocketAddr, store_dir: &Path, token_file: &Path) -> Result<()> {
    let options = ServeHistoryOptions::new(address, token_file);
    serve_history(file_history(store_dir)?, options).await
}
```

**TypeScript**

```ts
function serveStore(address: string, storeDir: string, tokenFile: string) {
  return serveHistory(fileHistory(storeDir), { address, tokenFile });
}
```

## Hand off a session

Connect each agent to the same URL and token file, with `kept` durability. Both use the same project. Each gets its own `dataDir` for local command recovery bookkeeping; the history goes to the service instead.

The first agent prompts once and saves the session ID. Close that agent or session before the second opens it: only one writer can hold a session at a time. If the first process crashed, the old lease may take time to expire; a `held` error can carry `retryAfterMs`. See [Writing: one writer at a time](../../bindings/history-http.md#writing-one-writer-at-a-time).

The tests run both agents in each SDK against a real loopback service, without a real model. The scripted Provider's second answer is selected only when the reopened session's earlier answer is in model context. The tests also check that the stored input actor IDs are unchanged.

**Rust**

```rust
async fn connect_history(
    project: &Path,
    data_dir: &Path,
    url: &str,
    token_file: &Path,
) -> Result<Agent> {
    Agent::builder()
        .project(project)
        .data_dir(data_dir)
        .durability(Durability::Kept)
        .history(http_history(url, token_file)?)
        .provider(scripted_provider(
            json!([{ "text": "Whitby." }, { "text": "14:02." }]),
        ))
        .model("scripted/script")
        .build()
        .await
}

async fn handoff(
    project: &Path,
    writer_dir: &Path,
    reader_dir: &Path,
    url: &str,
    token_file: &Path,
) -> Result<()> {
    let writer = connect_history(project, writer_dir, url, token_file).await?;
    let first = writer.session().await?;
    assert_eq!(first.prompt("Name a harbour.").await?.text, "Whitby.");
    let id = first.id().to_owned();
    writer.close().await?; // Give up the writer lease.

    let reader = connect_history(project, reader_dir, url, token_file).await?;
    let reopened = reader.open_session(&id).await?;
    assert_eq!(reopened.last_turn().await?.unwrap().text, "Whitby.");
    assert_eq!(
        reopened.prompt("When is high tide there?").await?.text,
        "14:02."
    );
    let history = reopened.history().await?;
    let actors: Vec<_> = history
        .iter()
        .filter(|entry| entry["kind"] == "input")
        .map(|entry| entry["actorId"].as_str())
        .collect();
    assert_eq!(actors, [Some("user"), Some("user")]);
    reader.close().await
}
```

**TypeScript**

```ts
function connectHistory(project: string, dataDir: string, url: string, tokenFile: string) {
  return createAgent({
    project, dataDir, durability: "kept",
    history: httpHistory(url, tokenFile),
    providers: [scriptedProvider([{ text: "Whitby." }, { text: "14:02." }])],
    model: "scripted/script",
  });
}

async function handoff(project: string, writerDir: string, readerDir: string, url: string, tokenFile: string) {
  const writer = await connectHistory(project, writerDir, url, tokenFile);
  let id: string;
  try {
    const first = await writer.session();
    assert.equal((await first.prompt("Name a harbour.")).text, "Whitby.");
    id = first.id;
  } finally {
    await writer.close(); // Give up the writer lease.
  }

  const reader = await connectHistory(project, readerDir, url, tokenFile);
  try {
    const reopened = await reader.openSession(id);
    assert.equal((await reopened.lastTurn())?.text, "Whitby.");
    assert.equal((await reopened.prompt("When is high tide there?")).text, "14:02.");
    const history = await reopened.history();
    assert.deepEqual(history.filter(e => e.kind === "input").map(e => e.actorId), ["user", "user"]);
  } finally {
    await reader.close();
  }
}
```

## Switch languages

For example, on the same host, keep the history service running. Use the Rust `connect_history` above to write the first turn, then pass the printed ID to a TypeScript program using `connectHistory`. Use the same URL, token and canonical project path, and separate local data directories. This mixed-language example is shown, not run in the guide tests.

**Rust writer**

```rust
let writer = connect_history(project, writer_dir, url, token_file).await?;
let first = writer.session().await?;
first.prompt("Name a harbour.").await?;
let id = first.id().to_owned();
writer.close().await?;
println!("{id}");
```

**TypeScript reader**

```ts
async function resume(id: string) {
  const reader = await connectHistory(project, readerDir, url, tokenFile);
  try {
    const reopened = await reader.openSession(id);
    const turn = await reopened.prompt("When is high tide there?");
    console.log(turn.text);
  } finally {
    await reader.close();
  }
}
```

## Keep identity and portability separate

Both embedded agents in the example act as `user`. In an app with authenticated actors, use the same stable actor ID for the same principal across deployments. A session ID tells the agent what to open, not who is asking. A history token authenticates access to the store; it does not authenticate a session actor. An Interface such as ACP authenticates its own actors, and reopening does not reset recorded rights or undo a departure. See [Actors and rights](../api.md#actors-and-rights) and [Authority](../../contracts.md#authority).

Use `kept` or `durable` with persistent history for portable sessions. Two builds declaring `portableSessions` can read, replay and extend each other's standard session records. The project and lineage are part of the stored session header; sending just its entries is not the same as sharing the session. Provider state, credentials, arbitrary plugin state and working-environment snapshots do not travel with the session. Configure the model, tools and other parts the reader needs. Resuming interrupted work still depends on the receiving Runtime and its safety checks, not just on being able to read the record. See [Portable sessions](../../bindings/data.md#portable-sessions) and [Sessions that survive a crash](05-sessions-that-survive-a-crash.md).
