// `pnpm adr:extract [--at <ref>] [--since <ref>] [--out <dir>]`: lists every
// code and config Decision comment at <ref> (the snapshot by default, HEAD
// with --since), one item per tag, and writes them as per-context batches to
// <out>/batches/. It prints its count beside a `git grep` of the same tree and
// names every grep hit that is not an item. --since keeps only the decisions
// added or changed since that commit, for the catch-up before the apply, and
// writes the sites whose decision was removed or changed to <out>/gone.json.
import { parseArgs as parseCliArgs } from "node:util"

import { Console, Effect, FileSystem, Path } from "effect"
import { Stdio } from "effect/Stdio"
import { parse as parseYaml } from "yaml"

import { CheckFailed, repoRoot } from "../lib/check.mts"
import { gitLines, stdoutOf } from "../lib/command.mts"
import { runScript } from "../lib/run.mts"
import {
  decisionsIn,
  goneName,
  notesDir,
  pathspec,
  snapshot,
  tag,
  type Item,
} from "./triage.mts"

const USAGE =
  "Usage: pnpm adr:extract [--at <ref>] [--since <ref>] [--out <dir>]"
const maxBatch = 80

type Decision = typeof Item.Type

// Map.groupBy, which the root tsconfig's ES2022 lib does not declare.
const groupBy = <T,>(items: ReadonlyArray<T>, key: (item: T) => string) => {
  const groups = new Map<string, Array<T>>()
  for (const item of items) {
    const group = groups.get(key(item))
    if (group === undefined) groups.set(key(item), [item])
    else group.push(item)
  }
  return groups
}

// pnpm workspaces as `apps/x` folders, read from pnpm-workspace.yaml at ref.
const workspacesAt = Effect.fnUntraced(function* (root: string, ref: string) {
  const manifest: unknown = parseYaml(
    yield* stdoutOf("git", ["show", `${ref}:pnpm-workspace.yaml`], {
      cwd: root,
    })
  )
  const globs =
    typeof manifest === "object" &&
    manifest !== null &&
    "packages" in manifest &&
    Array.isArray(manifest.packages)
      ? manifest.packages.map(String)
      : []
  const files = yield* gitLines(root, ["ls-tree", "-r", "--name-only", ref])
  return files
    .filter((file) =>
      globs.some((glob) =>
        new RegExp(`^${glob.replace("/*", "/[^/]+")}/package\\.json$`).test(
          file
        )
      )
    )
    .map((file) => file.replace(/\/package\.json$/, ""))
})

// The tree's grep hits and the decisions in the files they name.
const extractAt = Effect.fnUntraced(function* (root: string, ref: string) {
  const grep = yield* gitLines(root, [
    "grep",
    "-n",
    "-e",
    tag,
    ref,
    ...pathspec,
  ])
  const hits = grep.map((hit) => {
    const [file = "", line = "", ...text] = hit.slice(ref.length + 1).split(":")
    return { file, line: Number(line), text: text.join(":") }
  })
  const workspaces = yield* workspacesAt(root, ref)
  const files = [...new Set(hits.map((hit) => hit.file))]
  const read = yield* Effect.forEach(
    files,
    Effect.fnUntraced(function* (file) {
      const text = yield* stdoutOf("git", ["show", `${ref}:${file}`], {
        cwd: root,
      })
      return { file, ...(yield* decisionsIn(file, text, workspaces)) }
    }),
    { concurrency: 16 }
  )
  return {
    hits,
    unparsed: new Set(read.filter((f) => !f.parsed).map((f) => f.file)),
    decisions: read.flatMap((f) => f.decisions),
  }
})

const reasonFor = (
  hit: { file: string; text: string },
  unparsed: ReadonlySet<string>
) =>
  unparsed.has(hit.file)
    ? "file does not parse"
    : /`[^`]*Decision:/.test(hit.text) || hit.text.includes("`Decision:")
      ? "backticked: prose about the tag"
      : /\.(m?[jt]sx?|jsonc?|ya?ml|sql|sh|css)$/.test(hit.file)
        ? "not in a comment (a string or code)"
        : "file type holds no parsed comments"

// A context's batches, each at most ~80 items, split only between files.
const batchesOf = (context: string, items: ReadonlyArray<Decision>) => {
  if (items.length <= maxBatch) return [{ name: context, items }]
  const target = Math.ceil(items.length / Math.ceil(items.length / maxBatch))
  const byFile = groupBy(items, (item) => item.file)
  const chunks: Array<Array<Decision>> = [[]]
  for (const group of byFile.values()) {
    const current = chunks.at(-1)!
    if (
      current.length > 0 &&
      (current.length >= target || current.length + group.length > maxBatch)
    )
      chunks.push([...group])
    else current.push(...group)
  }
  return chunks.map((chunk, index) => ({
    name: `${context}-${index + 1}`,
    items: chunk,
  }))
}

const extract = Effect.fn("extract")(function* (
  root: string,
  args: ReadonlyArray<string>
) {
  const parsed = yield* Effect.try({
    try: () =>
      parseCliArgs({
        args: [...args],
        options: {
          at: { type: "string" },
          since: { type: "string" },
          out: { type: "string" },
        },
      }),
    catch: (error) =>
      new CheckFailed({ summary: USAGE, findings: [String(error)] }),
  })
  const { since } = parsed.values
  const resolve = (ref: string) =>
    stdoutOf("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: root,
    }).pipe(Effect.map((sha) => sha.trim()))
  const at = yield* resolve(
    parsed.values.at ?? (since === undefined ? snapshot : "HEAD")
  )
  const sinceSha = since === undefined ? null : yield* resolve(since)
  const out = parsed.values.out ?? (yield* notesDir(sinceSha !== null))

  const { hits, unparsed, decisions: all } = yield* extractAt(root, at)
  const tagLines = new Set(all.map((item) => item.id))
  const missed = hits.filter((hit) => !tagLines.has(`${hit.file}:${hit.line}`))
  const grepIds = new Set(hits.map((hit) => `${hit.file}:${hit.line}`))
  const strays = all.filter((item) => !grepIds.has(item.id))

  yield* Console.log(`Tree ${at}`)
  yield* Console.log(
    `  git grep -n '${tag}' (code and config, no repos/ or Markdown): ${hits.length} lines`
  )
  yield* Console.log(`  extracted Decision comments: ${all.length}`)
  yield* Console.log(
    `  grep hits that are not a Decision comment: ${missed.length}`
  )
  const reasons = groupBy(missed, (hit) => reasonFor(hit, unparsed))
  for (const [reason, group] of reasons) {
    yield* Console.log(`    ${reason}: ${group.length}`)
    for (const hit of group)
      yield* Console.log(
        `      ${hit.file}:${hit.line}: ${hit.text.trim().slice(0, 90)}`
      )
  }
  if (strays.length > 0 || tagLines.size !== all.length)
    return yield* new CheckFailed({
      summary:
        "Extracted decisions that git grep did not find, or two on one line:",
      findings: [
        ...strays.map((item) => item.id),
        ...all
          .filter(
            (item, index) => all.findIndex((o) => o.id === item.id) !== index
          )
          .map((item) => `${item.id} (twice)`),
      ],
    })

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const goneFile = path.join(out, goneName)
  yield* fs.remove(goneFile, { force: true })
  let items = all
  if (sinceSha !== null) {
    const key = (item: Decision) =>
      `${item.file}\n${item.comment.replace(/\s+/g, " ")}`
    const old = (yield* extractAt(root, sinceSha)).decisions
    const oldKeys = new Set(old.map(key))
    const newKeys = new Set(all.map(key))
    items = all.filter((item) => !oldKeys.has(key(item)))
    const gone = old.filter((item) => !newKeys.has(key(item)))
    yield* Console.log(
      `Since ${sinceSha}: ${items.length} added or changed, ${gone.length} removed or changed at their old site`
    )
    for (const item of gone) yield* Console.log(`  gone: ${item.id}`)
    yield* fs.makeDirectory(out, { recursive: true })
    yield* fs.writeFileString(
      goneFile,
      `${JSON.stringify(
        gone.map((item) => item.id),
        null,
        2
      )}\n`
    )
  }

  const dir = path.join(out, "batches")
  yield* fs.remove(dir, { recursive: true, force: true })
  yield* fs.makeDirectory(dir, { recursive: true })
  const byContext = groupBy(items, (item) => item.context)
  const batches = [...byContext]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([context, group]) =>
      batchesOf(context, group).map((batch) => ({ context, ...batch }))
    )
  for (const batch of batches)
    yield* fs.writeFileString(
      path.join(dir, `${batch.name}.json`),
      `${JSON.stringify(
        {
          snapshot,
          at,
          since: sinceSha,
          batch: batch.name,
          context: batch.context,
          items: batch.items,
        },
        null,
        2
      )}\n`
    )
  yield* Console.log(`Wrote ${batches.length} batches to ${dir}:`)
  for (const batch of batches)
    yield* Console.log(`  ${batch.name}.json: ${batch.items.length}`)
})

runScript(
  Effect.gen(function* () {
    const args = yield* (yield* Stdio).args
    return yield* extract(yield* repoRoot, args)
  })
)
