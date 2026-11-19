// The row budgets' day object in workerd, where every SQL cursor counts the
// rows Cloudflare bills (docs/research/do-sql-billing.md on branch
// research/do-sql-billing, "How the counters work"). The layer bundles
// billing/worker.ts, runs it in the installed workerd on a temporary disk
// beside alchemy's local R2 (the one `alchemy dev` runs), builds the busy day
// (billing/busy-day.ts) once, and stops workerd when the tests are done.
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"

import { NodeServices } from "@effect/platform-node"
import { loadInternalWorker } from "@alchemy.run/cloudflare-runtime/core/internal/internal-worker"
import {
  BINDING_R2_BLOBS,
  BINDING_R2_OBJECT,
  R2_OBJECT_CLASS_NAME,
} from "@alchemy.run/cloudflare-runtime/core/bindings/r2-bucket/R2BucketOptions"
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schedule,
  Schema,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { build } from "vite"
import workerdBinary, { compatibilityDate } from "workerd"

import { WHOLE_DAY } from "../../../billing/busy-figures"
import type { OperationName } from "../../../billing/operations"

const Rows = Schema.Struct({
  rowsRead: Schema.Number,
  rowsWritten: Schema.Number,
})

// What one operation billed: the trading day's start, its uncounted
// `before`, and the operation itself; the operation's answer, and the
// tables the day holds after it.
const Billed = Schema.Struct({
  start: Rows,
  before: Rows,
  rows: Rows,
  status: Schema.Number,
  answer: Schema.String,
  tables: Schema.Array(Schema.String),
})

// What the whole day billed in its live hours, its seal and its walk; the
// rows its flushes and recomputes logged, by table; its database's size and
// each table's payload bytes; its sweep brokers rows' stored and plain
// bytes; its trade chunks; the codes it holds books of, and its candles.
const WholeDay = Schema.Struct({
  live: Rows,
  seal: Rows,
  walk: Rows,
  total: Rows,
  written: Schema.Record(Schema.String, Schema.Number),
  databaseBytes: Schema.Number,
  tables: Schema.Record(Schema.String, Schema.Number),
  sweepBrokers: Schema.Struct({
    rows: Schema.Number,
    stored: Schema.Number,
    plain: Schema.Number,
    ratio: Schema.Number,
  }),
  tradeChunks: Schema.Struct({ rows: Schema.Number, bytes: Schema.Number }),
  bookCodes: Schema.Number,
  stockMinutes: Schema.Number,
})

const decodeWholeDay = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WholeDay)
)

// An answer as the browser reads it: its status and body.
const ReadBack = Schema.Struct({ status: Schema.Number, body: Schema.String })

// What a move to R2 billed: its rows and alarm runs, what its deleteAll()
// billed, the tables left, and each checked resource's answer from the
// object before the move and from R2 after it, with the gets R2 served for
// it (`key` or `key offset+length`), and its values before and after.
const Moved = Schema.Struct({
  rows: Rows,
  runs: Schema.Number,
  emptied: Schema.Record(Schema.String, Schema.Number),
  tables: Schema.Array(Schema.String),
  checks: Schema.Array(
    Schema.Struct({
      resource: Schema.String,
      hot: ReadBack,
      cold: ReadBack,
      gets: Schema.Array(Schema.String),
    })
  ),
  // The day's answer to the next trading day's ask for its values.
  values: Schema.Struct({ hot: ReadBack, cold: ReadBack }),
})

const decodeMoved = Schema.decodeUnknownEffect(Schema.fromJsonString(Moved))
const decodeBilled = Schema.decodeUnknownEffect(Schema.fromJsonString(Billed))
const decodeBuilt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ ms: Schema.Number }))
)

const dashboard = `${import.meta.dirname}/../../..`

// The Worker as one ES module, Node built-ins and `cloudflare:` modules left
// to workerd.
const bundle = (outDir: string) =>
  Effect.promise(() =>
    build({
      configFile: false,
      root: dashboard,
      logLevel: "error",
      publicDir: false,
      resolve: {
        tsconfigPaths: true,
        conditions: ["workerd", "worker", "module", "import"],
      },
      ssr: { target: "webworker", noExternal: true },
      build: {
        ssr: "billing/worker.ts",
        outDir,
        emptyOutDir: true,
        minify: false,
        target: "esnext",
        rollupOptions: {
          external: [/^cloudflare:/, /^node:/],
          output: { entryFileNames: "worker.js" },
        },
      },
    })
  )

// A port no socket holds right now.
const freePort = Effect.callback<number>((resume) => {
  const server = createServer()
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    const port =
      typeof address === "object" && address !== null ? address.port : 0
    server.close(() => resume(Effect.succeed(port)))
  })
})

// The local R2 worker's one module, as alchemy ships it.
const R2_MODULE = "r2/R2Bucket.worker.mjs"

// Decision: the research harness's config: one SQLite-backed namespace on a
// local disk, since in-memory storage is not SQLite-backed. The compatibility
// date is the installed workerd's own, which has nodejs_compat on. The DAYS
// bucket is alchemy's local R2 service, wired as its R2Bucket.ts wires it: a
// Durable Object for each bucket's keys and a disk for their bodies.
const config = (
  port: number
) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "main", worker = .billing),
               (name = "disk", disk = (path = "dodata", writable = true)),
               (name = "r2", worker = .r2),
               (name = "r2-storage", disk = (path = "r2data", writable = true)) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);

const billing :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "out/worker.js") ],
  compatibilityDate = "${compatibilityDate}",
  durableObjectNamespaces = [ (className = "BillingDay", uniqueKey = "billing", enableSql = true) ],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [ (name = "DAY", durableObjectNamespace = "BillingDay"),
               (name = "DAYS", r2Bucket = (name = "r2", props = (json = "{\\"bucketName\\":\\"days\\"}"))) ],
);

const r2 :Workerd.Worker = (
  modules = [ (name = "r2", esModule = embed "${R2_MODULE}") ],
  compatibilityDate = "${compatibilityDate}",
  durableObjectNamespaces = [ (className = "${R2_OBJECT_CLASS_NAME}", uniqueKey = "r2", enableSql = true, preventEviction = true) ],
  durableObjectStorage = (localDisk = "r2-storage"),
  bindings = [ (name = "${BINDING_R2_OBJECT}", durableObjectNamespace = "${R2_OBJECT_CLASS_NAME}"),
               (name = "${BINDING_R2_BLOBS}", service = "r2-storage") ],
);
`

class WorkerdRefused extends Schema.TaggedError<WorkerdRefused>()(
  "WorkerdRefused",
  { path: Schema.String, status: Schema.Number, body: Schema.String }
) {}

export class BusyDay extends Context.Service<
  BusyDay,
  {
    // How long building the busy day took, in ms.
    readonly builtInMs: number
    readonly billed: (
      operation: OperationName
    ) => Effect.Effect<typeof Billed.Type>
    // A whole busy day recorded on an object of its own
    // (billing/whole-day.ts), and what it billed.
    readonly wholeDay: Effect.Effect<typeof WholeDay.Type>
    // The busy day moved to the local R2: it empties the busy day's object.
    readonly moved: Effect.Effect<typeof Moved.Type>
  }
>()("BusyDay") {
  static readonly layer = Layer.effect(
    BusyDay,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "row-budgets-" })
      yield* bundle(path.join(dir, "out"))
      yield* fs.makeDirectory(path.join(dir, "dodata"))
      yield* fs.makeDirectory(path.join(dir, "r2data"))
      yield* fs.makeDirectory(path.join(dir, "r2"))
      const r2Worker = yield* Effect.promise(() =>
        loadInternalWorker(
          "#cloudflare-runtime-core-worker/bindings/r2-bucket/R2Bucket.worker"
        )
      )
      yield* fs.writeFileString(
        path.join(dir, R2_MODULE),
        r2Worker.modules[r2Worker.main]!
      )
      const port = yield* freePort
      yield* fs.writeFileString(path.join(dir, "config.capnp"), config(port))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.spawn(
        ChildProcess.make(workerdBinary, ["serve", "config.capnp"], {
          cwd: dir,
          stdout: "ignore",
          stderr: "inherit",
        })
      )
      const ask = Effect.fnUntraced(function* (
        route: string,
        init?: RequestInit
      ) {
        const response = yield* Effect.tryPromise(() =>
          fetch(`http://127.0.0.1:${port}${route}`, init)
        )
        const body = yield* Effect.promise(() => response.text())
        if (!response.ok)
          return yield* new WorkerdRefused({
            path: route,
            status: response.status,
            body,
          })
        return body
      })
      // workerd takes a moment to listen.
      const built = yield* ask("/build", { method: "POST" }).pipe(
        Effect.retry({
          while: (error) => !(error instanceof WorkerdRefused),
          schedule: Schedule.spaced("100 millis"),
          times: 100,
        }),
        Effect.flatMap(decodeBuilt)
      )
      return {
        builtInMs: built.ms,
        moved: ask("/moved", { method: "POST" }).pipe(
          Effect.flatMap(decodeMoved),
          Effect.orDie
        ),
        billed: (operation: OperationName) =>
          ask(`/billed?operation=${encodeURIComponent(operation)}`).pipe(
            Effect.flatMap(decodeBilled),
            Effect.orDie
          ),
        // Decision: through node:http, which sets no timeout: the whole day
        // answers after about 280 s, past fetch's 300 s headers timeout on
        // CI's slower cores.
        wholeDay: Effect.callback<string>((resume) => {
          const request = httpRequest(
            { host: "127.0.0.1", port, path: WHOLE_DAY.path, method: "POST" },
            (response) => {
              let body = ""
              response.setEncoding("utf8")
              response.on("data", (chunk: string) => (body += chunk))
              response.on("end", () =>
                resume(
                  response.statusCode === 200
                    ? Effect.succeed(body)
                    : Effect.die(
                        `${WHOLE_DAY.path} answered ${response.statusCode}: ${body}`
                      )
                )
              )
            }
          )
          request.on("error", (error) => resume(Effect.die(error)))
          request.end()
        }).pipe(Effect.flatMap(decodeWholeDay), Effect.orDie),
      }
    }).pipe(Effect.orDie)
  ).pipe(Layer.provide(NodeServices.layer))
}
