// `pnpm adr:repro`: runs merge and approve over builds of the real manifest and
// decisions, in a copy of scripts/ under a temp directory, and fails unless
// each case below holds. Both came from the round-1 review of
// apinrdw/kumora#651.
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess } from "effect/process"

import { CheckFailed, repoRoot } from "../lib/check.mts"
import { collect } from "../lib/command.mts"
import { runScript } from "../lib/run.mts"
import { Approved, snapshot, triageDir } from "./triage.mts"

// An agreed-adr decision of one site.
const flipped = {
  key: "packages/client/viewer-sockets-reconnect-on-any-close-but-4401-and-4426",
  site: "packages/client/src/market-live-socket.ts:34",
}
// Snapshot rows the catch-up finds gone: one reworded on its line, one
// reworded and moved a line down, and one deleted, which was a site of `kept`.
const reworded = "packages/client/src/recorded-day.ts:5"
const moved = {
  from: "packages/client/src/recorded-day.ts:169",
  to: "packages/client/src/recorded-day.ts:170",
}
const deleted = "apps/extension/src/worker/broker-codes/status.ts:53"
const kept =
  "packages/relay/broker-codes-refusals-401-refuses-the-token-426-means-reload"

const Rows = Schema.fromJsonString(
  Schema.Struct({
    rows: Schema.Array(
      Schema.Struct({
        site: Schema.String,
        file: Schema.String,
        line: Schema.Number,
        endLine: Schema.Number,
        context: Schema.String,
        workspace: Schema.String,
        comment: Schema.String,
      })
    ),
  })
)

// Approve run in the copy at `root` on `verdicts`: its exit code, its output,
// and what it wrote.
const approveIn = Effect.fnUntraced(function* (
  root: string,
  name: string,
  verdicts: Record<string, string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const verdictsFile = path.join(root, `${name}-verdicts.json`)
  const out = path.join(root, `${name}-approved.json`)
  yield* fs.writeFileString(verdictsFile, JSON.stringify(verdicts))
  const run = yield* collect(
    ChildProcess.make(
      "node",
      [
        path.join(root, triageDir, "approve.mts"),
        "--verdicts",
        verdictsFile,
        "--out",
        out,
      ],
      { cwd: root }
    )
  )
  if (run.exitCode !== 0)
    return { problems: [`approve exited ${run.exitCode}: ${run.stderr}`] }
  const approved = yield* Effect.flatMap(
    fs.readFileString(out),
    Schema.decodeEffect(Approved)
  )
  return { problems: [], approved }
})

// A flipped decision is dropped and its site becomes a comment.
const flipCase = Effect.fnUntraced(function* (root: string) {
  const { problems, approved } = yield* approveIn(root, "flip", {
    [flipped.key]: "flip",
  })
  if (approved === undefined) return problems
  return [
    ...(approved.decisions.some(({ key }) => key === flipped.key)
      ? [`${flipped.key} is still a decision`]
      : []),
    ...(approved.comments.includes(flipped.site)
      ? []
      : [`${flipped.site} is not a comment`]),
  ]
})

// A catch-up's reworded, moved and deleted rows replace their snapshot rows.
const catchupCase = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { rows } = yield* Effect.flatMap(
    fs.readFileString(path.join(root, triageDir, "manifest.json")),
    Schema.decodeEffect(Rows)
  )
  const row = (site: string) => rows.filter((each) => each.site === site)
  const items = [
    ...row(reworded),
    ...row(moved.from).map((each) => ({
      ...each,
      site: moved.to,
      line: each.line + 1,
      endLine: each.endLine + 1,
    })),
  ].map(({ site, ...item }) => ({
    ...item,
    id: site,
    comment: `${item.comment} Reworded.`,
    code: "",
  }))
  const notes = path.join(root, "catchup")
  const judged = JSON.stringify(
    items.map(({ id }) => ({
      id,
      call: "comment",
      gist: "reworded since the snapshot",
      clause: "local",
    }))
  )
  yield* fs.makeDirectory(path.join(notes, "batches"), { recursive: true })
  yield* fs.writeFileString(
    path.join(notes, "batches", "client.json"),
    JSON.stringify({
      snapshot,
      at: "HEAD",
      since: snapshot,
      batch: "client",
      context: "client",
      items,
    })
  )
  yield* fs.writeFileString(
    path.join(notes, "gone.json"),
    JSON.stringify([reworded, moved.from, deleted])
  )
  for (const judge of ["opus", "fable"]) {
    yield* fs.makeDirectory(path.join(notes, "judges", judge), {
      recursive: true,
    })
    yield* fs.writeFileString(
      path.join(notes, "judges", judge, "client.json"),
      judged
    )
  }
  const merged = yield* collect(
    ChildProcess.make(
      "node",
      [
        path.join(root, triageDir, "merge.mts"),
        "--dir",
        notes,
        "--manifest",
        path.join(root, triageDir, "manifest-catchup.json"),
      ],
      { cwd: root }
    )
  )
  if (merged.exitCode !== 0)
    return [`merge exited ${merged.exitCode}: ${merged.stderr}`]
  const { problems, approved } = yield* approveIn(root, "catchup", {})
  if (approved === undefined) return problems
  const sites = [
    ...approved.comments,
    ...approved.decisions.flatMap((decision) => decision.sites),
  ]
  const count = (site: string) => sites.filter((each) => each === site).length
  const want = rows.length - 1
  return [
    ...(sites.length === want
      ? []
      : [`approved ${sites.length} sites, not ${want}`]),
    ...[
      [reworded, 1],
      [moved.to, 1],
      [moved.from, 0],
      [deleted, 0],
    ].flatMap(([site, times]) =>
      count(String(site)) === times
        ? []
        : [`${site} is approved ${count(String(site))} times, not ${times}`]
    ),
    ...(approved.decisions.some(({ key }) => key === kept)
      ? []
      : [`${kept} lost its other sites`]),
  ]
})

const repro = Effect.fn("repro")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const copy = yield* fs.makeTempDirectoryScoped({ prefix: "adr-repro-" })
  yield* fs.copy(path.join(root, "scripts"), path.join(copy, "scripts"))
  yield* fs.symlink(
    path.join(root, "node_modules"),
    path.join(copy, "node_modules")
  )
  const flip = yield* flipCase(copy)
  const catchup = yield* catchupCase(copy)
  const findings = [
    ...flip.map((problem) => `flip: ${problem.trimEnd()}`),
    ...catchup.map((problem) => `catch-up: ${problem.trimEnd()}`),
  ]
  yield* Console.log(`flip: ${flip.length === 0 ? "ok" : "FAILED"}`)
  yield* Console.log(`catch-up: ${catchup.length === 0 ? "ok" : "FAILED"}`)
  if (findings.length > 0)
    return yield* new CheckFailed({
      summary: "The triage tooling gets these wrong:",
      findings,
    })
}, Effect.scoped)

runScript(Effect.flatMap(repoRoot, repro))
