# What Quack in DuckDB 2.0 offers a Cloudflare Worker reading a database on a remote box

Research for apinrdw/kumora#535 (map apinrdw/kumora#534). Sources are duckdb.org's docs and blog, the `duckdb/duckdb-quack` source on its `v2.0-cyanoptera` branch and its issues, the `@quack-protocol/sdk` package, and Cloudflare's Workers docs, read 2026-11-18. The box is the owner's Hostinger KVM 2 (2 vCPU, 8 GB). The client is the dashboard Worker (TanStack Start + Effect), which has `fetch`, WebSocket and `connect()` but no native code.

## Short answer

Quack is plain HTTP: every message is a `POST /quack` with a DuckDB binary-serialized body, and the client drives every exchange. So a Worker can speak it with `fetch`, and no native code is needed. DuckDB itself ships no JavaScript client that runs on Workers. Its Wasm build makes HTTP calls through DuckDB's HTTP layer, and the only Workers build of DuckDB-Wasm found (`@ducklings/workers`, DuckDB 1.4.3) has no Quack. A third-party, pure-TypeScript client, `@quack-protocol/sdk` 0.3.0, uses only `fetch` and targets DuckDB 2.0's wire version 3. It is one person's project with 30 stars, and it reimplements DuckDB's internal serialization, which DuckDB says is not stable.

Quack in 2.0 is still young. The README calls it "experimental", the FAQ calls it beta and promises breaking changes to the protocol, and the wire version already moved from 1.5.x to 3. Issues filed since 2.0.0 include a hang at 100 % CPU, a 5 s server write timeout that breaks large results, and SQL auth callbacks that any client with a token can replace. Its access control is coarse. A token admits a client to the whole server session, `READ_ONLY` attach is refused because Quack could not enforce it, and read-only access holds only with an authorization callback that allows nothing but `SELECT`.

The cheapest safe bridge is not Quack on the open internet. The map already embeds DuckDB in the Node or Bun ingest service, and a DuckDB file has one writing process, so that service owns the database. A few HTTP read routes on that service, behind a TLS reverse proxy (or a Cloudflare Tunnel), give the Worker typed, read-only queries with the stage chosen by the route. Quack is still useful on the box for ad hoc analytics from a DuckDB CLI over SSH or a tunnel, where `quack_serve` can run inside the same process.

## Wire protocol and transport

| Fact         | Value                                                                                                                                                                             | Source                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Transport    | HTTP. "Quack messages travel over plain HTTP or HTTPS via a reverse proxy." No WebSocket or custom TCP framing                                                                    | [Overview][overview]; [announcement][blog]                                   |
| Endpoint     | `POST /quack`, body and response typed `application/vnd.duckdb`; `GET /` and `OPTIONS /quack` also served                                                                         | `src/quack_http_server.cpp` ([source][http-server])                          |
| CORS         | `Access-Control-Allow-Origin: *` on `/quack` and its preflight                                                                                                                    | `src/quack_http_server.cpp` ([source][http-server])                          |
| Encoding     | DuckDB's internal `BinarySerializer`; results are serialized `DataChunk`s                                                                                                         | [Announcement][blog]; `src/include/quack_message.json` ([source][msg-json])  |
| Flow         | Always client-initiated request and response; no server push                                                                                                                      | [Announcement][blog]                                                         |
| Messages     | `CONNECTION_REQUEST/RESPONSE`, `PREPARE_REQUEST/RESPONSE`, `FETCH_REQUEST/RESPONSE`, `SEND_DATA_*`, `CANCEL_REQUEST`, `HEARTBEAT_REQUEST`, `DISCONNECT_MESSAGE`, `ERROR_RESPONSE` | `src/include/quack_message.hpp` ([source][msg-hpp])                          |
| Round trips  | Once connected, one request per query. A result over `quack_prepare_inline_rows` (24,576 rows) or the batch size comes back through more `FETCH` requests                         | [Announcement][blog]; [Reference][reference]                                 |
| Wire version | `QUACK_VERSION = 3` in 2.0. The server rejects a client whose min/max range excludes it                                                                                           | `src/include/quack_extension.hpp`, `src/quack_server.cpp` ([source][server]) |
| Default port | 9494                                                                                                                                                                              | [Overview][overview]                                                         |

A Worker's `fetch` covers all of this. Nothing needs `connect()` or WebSockets.

## Clients a Worker could use

| Client                                               | Runs on Workers?  | Notes                                                                                                                                                                                                                                                                                                                                                                         | Source                                                 |
| ---------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| DuckDB native (CLI, Node `@duckdb/node-api`, Python) | No                | Native code. Usable from the box itself or a laptop                                                                                                                                                                                                                                                                                                                           | [Overview][overview]                                   |
| DuckDB-Wasm 2.0                                      | Not shown         | Quack's client posts through DuckDB's `HTTPUtil` (`src/quack_client.cpp`). Wasm support was fixed for browsers only after 2.0.0 (#328, #330, a heartbeat `std::thread`). Workers have no synchronous `XMLHttpRequest`, which the browser build relies on (inference from the ducklings docs)                                                                                  | [source][client]; [#328][i328]; [ducklings][ducklings] |
| `@ducklings/workers`                                 | Yes, but no Quack | DuckDB 1.4.3 Wasm with Asyncify `fetch`; only `httpfs` and `parquet` bundled; about 12.3 MiB gzipped                                                                                                                                                                                                                                                                          | [ducklings][ducklings]                                 |
| `@quack-protocol/sdk` 0.3.0                          | Yes, by design    | Pure TypeScript over `fetch`, ESM, depends on `@uwdata/flechette` for Arrow. Speaks wire version 3 (DuckDB 2.0+); 0.2.x is for 1.5.x. Implements connect, query, fetch, append, transactions, cancel, timeouts, Arrow output. Parameters are formatted into SQL on the client because Quack has no bind message. Repo `tobilg/quack-protocol`: 30 stars, last push 2026-10-22 | [README][sdk]; npm registry                            |

Worker limits that matter for a Wasm client: 64 MiB uncompressed bundle with no compressed limit, 128 MB memory per isolate shared with Wasm, 1 s startup ([Workers limits][wlimits]). The TypeScript SDK avoids all of them.

## Auth and TLS

| Fact                          | Value                                                                                                                                                                                                                                                                                                                                         | Source                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Token                         | `quack_serve(token = ...)`, or a `quack` secret, or a random token returned in `auth_token`. Minimum 4 characters                                                                                                                                                                                                                             | [Reference][reference]; [README][readme]; `src/quack_server.cpp` ([source][server]) |
| Where it travels              | In the binary `CONNECTION_REQUEST` body (`auth_string`), not an HTTP header                                                                                                                                                                                                                                                                   | `quack_message.json` ([source][msg-json])                                           |
| Proxy auth                    | The client's `EXTRA_HTTP_HEADERS` adds headers to every request, for a proxy or load balancer                                                                                                                                                                                                                                                 | [README][readme]                                                                    |
| More than one client or token | Replace `quack_authentication_function` (signature `(session_id, client_token, server_token)`) with a lookup in a token table; adding a user is an `INSERT`                                                                                                                                                                                   | [Security][security]                                                                |
| Rotation                      | No procedure documented. With the default check, a new token means restarting the server with another `token`                                                                                                                                                                                                                                 | [Security][security]                                                                |
| Authorization                 | `quack_authorization_function(connection_id, query)` may reject or rewrite each query. Default allows everything                                                                                                                                                                                                                              | [Security][security]                                                                |
| Read-only                     | `READ_ONLY` attach is refused ("not currently supported") because writes are pushed down as whole statements and skip the check (#327, #329). The docs' regex filter is "not a robust read-only filter". What holds: the default token check plus an authorization callback that allows only `SELECT_NODE`, checked with `json_serialize_sql` | [#329][i329]; [Security][security]; [#325][i325]                                    |
| Callback hijack               | SQL-macro callbacks and token tables live in a catalog clients can write, so one valid token can replace them (#325, open)                                                                                                                                                                                                                    | [#325][i325]                                                                        |
| TLS                           | Off for local URIs. A non-local bind needs `allow_other_hostname = true` and serves HTTPS with a self-signed certificate unless `ssl_cert_file`/`ssl_key_file` are given. The docs recommend binding to localhost behind a TLS-terminating reverse proxy, and "do not expose Quack directly to the internet"                                  | [Overview][overview]; [Security][security]; [announcement][blog]                    |

## Concurrency, writes and databases per server

| Fact                   | Value                                                                                                                                                                                                                                                        | Source                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Writes                 | Clients can run DDL, inserts and forwarded transactions; "multiple concurrent writers from separate processes"                                                                                                                                               | [Overview][overview]; [announcement][blog]                                      |
| Why it exists          | Without Quack, only one process can write a DuckDB file; read-only mode allows many readers and no writer                                                                                                                                                    | [Concurrency][concurrency]                                                      |
| Connections            | `quack_server_max_connections` = 1024; a thread per connection, shed at the cap ("clients retry"); keep-alive 300 s                                                                                                                                          | [Reference][reference]; `src/quack_http_server.cpp` ([source][http-server])     |
| Sessions               | Each connection holds a heartbeat lease (default 60 s). Once it lapses the session cannot be revived; a later request gets "Invalid connection id" (#336, #352)                                                                                              | [Reference][reference]; `src/quack_server.cpp` ([source][server]); [#336][i336] |
| Throughput measured    | Single-row insert transactions: 1,038 tx/s on 1 thread to 5,434 on 8, capped near 5,500 by DuckDB's concurrent-insert limit (AWS m8g.2xlarge, 0.28 ms ping). FAQ: "a few thousand writes per second on a server with 8 CPUs and 32 GB RAM"                   | [Announcement][blog]; [FAQ][faq]                                                |
| Bulk transfer measured | 1 M rows 0.24 s, 10 M rows 0.89 s, same zone                                                                                                                                                                                                                 | [Announcement][blog]                                                            |
| Databases per server   | A server exposes its DuckDB instance's session: "in-memory tables, attached files, schemas". One process can attach one file per stage. `quack_server_list()` and `quack_stop(uri)` imply several servers per process, one per port, each with its own token | [Overview][overview]; [Reference][reference]                                    |
| Stage isolation        | Not built in. One token sees every attached file; separating stages needs a server (port and token) per stage or an authorization callback                                                                                                                   | Inference from [Security][security]                                             |

## Result size and latency

| Fact            | Value                                                                                                                                                                                                                                                                   | Source                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Batch size      | `quack_target_batch_bytes` = 32 MiB per `FETCH`                                                                                                                                                                                                                         | [Reference][reference]                                         |
| Server buffer   | `quack_server_stream_buffer_bytes` = 256 MiB, at most a quarter of `memory_limit`                                                                                                                                                                                       | [Reference][reference]                                         |
| Result lifetime | `quack_result_ttl` = 3600 s                                                                                                                                                                                                                                             | [Reference][reference]                                         |
| Write timeout   | Server drops a response it cannot write for 5 s (cpp-httplib default, not configurable), so slow links fail with "Transferred a partial file" (#354, open)                                                                                                              | [#354][i354]                                                   |
| Worker side     | Workers enforce no fetch response-body limit; 6 connections per invocation may wait for headers at once                                                                                                                                                                 | [Workers limits][wlimits]                                      |
| Latency         | DuckDB publishes only same-zone numbers. Worker-to-box latency is the network round trip times the round trips: a connect plus a prepare per request, unless the Worker keeps a session alive across requests, which the 60 s lease makes awkward in a stateless Worker | Inference from [announcement][blog] and [Reference][reference] |

## Maturity of 2.0.x's Quack

- DuckDB 2.0.0 was released 2026-10-21 ([GitHub releases][releases]; [2.0 highlights][highlights]).
- The extension README: "released as a pre-release extension and is currently experimental" ([README][readme]).
- FAQ: "Quack is currently in a beta state." Breaking changes are expected to the protocol, function names and defaults ([FAQ][faq]). The 2.0 highlights make no stability promise for Quack; the frozen ABI covers the C API only ([2.0 highlights][highlights]).
- The wire version already changed between 1.5.x and 2.0 (the SDK needs 0.2.x for one and 0.3.x for the other) ([README][sdk]).
- Open issues filed since 2.0.0, as of 2026-11-18 ([issues][issues]):
  - #356 a client statement never returns and spins a core at 100 %, with no error on either side.
  - #354 the 5 s server write timeout, above.
  - #325 SQL auth callbacks replaceable by any authenticated client.
  - #332 concurrent cursors of one connection cancel each other's queries.
  - #326 a late `CANCEL_REQUEST` can interrupt the next statement.
  - #361 `quack_stop` keeps serving connections that were already open.
  - #366 `quack_serve` ignores `enable_external_access`.
  - #349 a Python 2.0.0 server-mode IO error.
- The roadmap still lists a replication protocol for read replicas and more transactions per second past eight threads ([announcement][blog]).

## Bridges, cheapest first

1. **HTTP read routes in the ingest service.** The Node or Bun service already holds the DuckDB connection. It adds a few routes that each run one fixed, parameterized query and return JSON or Arrow IPC. The Worker calls them with `fetch` and a shared bearer token. Stage comes from the route or host, so one stage can never read another's file. The queries can't write, there's no extra process, and the wire format is not tied to DuckDB's internals. Cost: a route per query shape.
2. **Quack behind a proxy, Worker on `@quack-protocol/sdk`.** `quack_serve` runs inside the ingest process, bound to localhost, with one server per stage and an authorization callback that allows only `SELECT` (built in an extension, not a SQL macro, per #325). nginx or Caddy terminates TLS and checks a header the Worker sends through `headers`. This buys arbitrary SQL from the Worker. The costs are the SDK's bus factor, breaking protocol changes on DuckDB upgrades, and the open issues above.
3. **Cloudflare Tunnel in front of either.** `cloudflared` on the box opens no inbound port and gives the box a hostname under the zone, so the Worker reaches it without a public IP or a Let's Encrypt setup. This is a transport choice and leaves the choice between 1 and 2 open.

## Open points the sources don't settle

- Whether a Worker `fetch` accepts the self-signed certificate `quack_serve` generates. Assume it doesn't and use a proxy or tunnel with a real certificate.
- Whether Workers' `fetch` reaches port 9494 directly. Fronting it on 443 avoids the question.
- Real Worker-to-box latency. It depends on the box's region (the access ticket records it) and needs a measurement from a deployed Worker.
- Whether `@quack-protocol/sdk` handles every type the day store uses (nested lists of trades, decimals, hugeints) on DuckDB 2.0.x. A prototype against the box would settle it.
- Whether the Node client's process can host `quack_serve` next to the ingest writes without their transactions blocking each other. The docs imply it can, but nobody has measured it on 2 vCPUs.

[overview]: https://duckdb.org/docs/2.0/quack/overview
[reference]: https://duckdb.org/docs/2.0/quack/reference.html
[security]: https://duckdb.org/docs/2.0/quack/security.html
[faq]: https://duckdb.org/quack/faq.html
[concurrency]: https://duckdb.org/docs/2.0/connect/concurrency
[blog]: https://duckdb.org/2026/05/12/quack-remote-protocol
[highlights]: https://duckdb.org/2026/08/17/duckdb-20-highlights
[releases]: https://github.com/duckdb/duckdb/releases/tag/v2.0.0
[readme]: https://github.com/duckdb/duckdb-quack/blob/v2.0-cyanoptera/README.md
[http-server]: https://github.com/duckdb/duckdb-quack/blob/v2.0-cyanoptera/src/quack_http_server.cpp
[server]: https://github.com/duckdb/duckdb-quack/blob/v2.0-cyanoptera/src/quack_server.cpp
[client]: https://github.com/duckdb/duckdb-quack/blob/v2.0-cyanoptera/src/quack_client.cpp
[msg-json]: https://github.com/duckdb/duckdb-quack/blob/v2.0-cyanoptera/src/include/quack_message.json
[msg-hpp]: https://github.com/duckdb/duckdb-quack/blob/v2.0-cyanoptera/src/include/quack_message.hpp
[issues]: https://github.com/duckdb/duckdb-quack/issues
[i325]: https://github.com/duckdb/duckdb-quack/issues/325
[i328]: https://github.com/duckdb/duckdb-quack/issues/328
[i329]: https://github.com/duckdb/duckdb-quack/pull/329
[i336]: https://github.com/duckdb/duckdb-quack/issues/336
[i354]: https://github.com/duckdb/duckdb-quack/issues/354
[sdk]: https://cdn.jsdelivr.net/npm/@quack-protocol/sdk@0.3.0/README.md
[ducklings]: https://ducklings-api.pages.dev/_ducklings/workers/
[wlimits]: https://developers.cloudflare.com/workers/platform/limits/
