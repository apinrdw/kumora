// The row budgets' day object in workerd, where every SQL cursor counts the
// rows Cloudflare bills (docs/research/do-sql-billing.md on branch
// research/do-sql-billing, "How the counters work"). The layer bundles
// billing/worker.ts, runs it in the installed workerd on a temporary disk,
// builds the busy day (billing/busy-day.ts) once, and stops workerd when the
// tests are done.
import { createServer } from "node:net"

import { NodeServices } from "@effect/platform-node"
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

// Decision: the research harness's config: one SQLite-backed namespace on a
// local disk, since in-memory storage is not SQLite-backed. The compatibility
// date is the installed workerd's own, which has nodejs_compat on.
const config = (
  port: number
) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "main", worker = .billing),
               (name = "disk", disk = (path = "dodata", writable = true)) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);

const billing :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "out/worker.js") ],
  compatibilityDate = "${compatibilityDate}",
  durableObjectNamespaces = [ (className = "BillingDay", uniqueKey = "billing", enableSql = true) ],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [ (name = "DAY", durableObjectNamespace = "BillingDay") ],
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
        billed: (operation: OperationName) =>
          ask(`/billed?operation=${encodeURIComponent(operation)}`).pipe(
            Effect.flatMap(decodeBilled),
            Effect.orDie
          ),
      }
    }).pipe(Effect.orDie)
  ).pipe(Layer.provide(NodeServices.layer))
}
