// Throwaway tooling for the ADR migration (apinrdw/kumora#643, ticket #644).
// What extract writes and merge reads: the batches of Decision comments, the
// judges' rows, and where both live. Deleted in the migration PR's last commit.
import { parseArgs as parseCliArgs } from "node:util"

import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"

import { anyTag, layComments, readComments } from "../decision-docs.mts"
import { CheckFailed } from "../lib/check.mts"

// The staging commit the classification reads (adr-migration's base).
export const snapshot = "71b142dcafa94681e8dd24baebdaa77b09aaa538"

export const judges = ["opus", "fable"] as const

// The four bar clauses of apinrdw/kumora#636, and `local` for a comment call.
const Clause = Schema.Literals([
  "binds-sites",
  "shapes-data",
  "guards-production",
  "repo-wide-tool",
  "local",
])

export const Item = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  line: Schema.Number,
  endLine: Schema.Number,
  context: Schema.String,
  workspace: Schema.String,
  comment: Schema.String,
  code: Schema.String,
})

export const tag = "Decision:"
const before = 5
const after = 10
// The code and config files a Decision comment can sit in, for `git grep`.
export const pathspec = [
  "--",
  ".",
  ":(exclude)repos",
  ":(exclude)*.md",
  ":(exclude)*.mdx",
  ":(exclude)scripts/adr-triage",
]

// The Decision comments in a file: one per tag, from the tag to the end of
// its comment or the first empty comment line.
export const decisionsIn = Effect.fnUntraced(function* (
  file: string,
  text: string,
  workspaces: ReadonlyArray<string>
) {
  const found = yield* readComments(file, text)
  if (Option.isNone(found)) return { parsed: false, decisions: [] }
  const source = text.split("\n")
  const workspace = workspaces.find((dir) => file.startsWith(`${dir}/`)) ?? "."
  const context = workspace === "." ? "root" : workspace.split("/").at(-1)!
  const decisions = (yield* layComments(file, text, found.value)).flatMap(
    ({ line, lines }) =>
      lines.flatMap((part, index): Array<typeof Item.Type> => {
        if (!anyTag.test(part)) return []
        const end = lines.findIndex((next, at) => at > index && next === "")
        const run = lines.slice(index, end < 0 ? lines.length : end)
        const first = line + index + 1
        const last = first + run.length - 1
        const from = Math.max(1, first - before)
        const to = Math.min(source.length, last + after)
        return [
          {
            id: `${file}:${first}`,
            file,
            line: first,
            endLine: last,
            context,
            workspace,
            comment: run.join("\n"),
            code: source
              .slice(from - 1, to)
              .map((src, at) => `${from + at}| ${src}`)
              .join("\n"),
          },
        ]
      })
  )
  return { parsed: true, decisions }
})

export const Batch = Schema.fromJsonString(
  Schema.Struct({
    snapshot: Schema.String,
    at: Schema.String,
    since: Schema.NullOr(Schema.String),
    batch: Schema.String,
    context: Schema.String,
    items: Schema.Array(Item),
  })
)

export const JudgeRows = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      call: Schema.Literals(["adr", "comment"]),
      gist: Schema.String,
      clause: Clause,
    })
  )
)

// The notes folder this ticket's files live in, outside the checkout.
export const notesDir = Effect.fnUntraced(function* (catchup: boolean) {
  const path = yield* Path.Path
  const home = yield* Config.String("HOME")
  const base = path.join(home, ".t3/notes/kumora/643")
  return catchup ? path.join(base, "catchup") : base
})

// The sites a catch-up extract found removed or changed since the snapshot:
// the file extract writes them to, and its content.
export const goneName = "gone.json"
export const Gone = Schema.fromJsonString(Schema.Array(Schema.String))

// The manifest rows approve and apply read: where each Decision comment sat at
// the snapshot, its text, and the two calls. A catch-up manifest also lists
// the sites that are `gone`.
const ManifestRows = Schema.fromJsonString(
  Schema.Struct({
    gone: Schema.optional(Schema.Array(Schema.String)),
    rows: Schema.Array(
      Schema.Struct({
        site: Schema.String,
        file: Schema.String,
        line: Schema.Number,
        comment: Schema.String,
        borderline: Schema.Boolean,
        opus: Schema.Struct({ call: Schema.String }),
        fable: Schema.Struct({ call: Schema.String }),
      })
    ),
  })
)

// The proposed decisions the grouping wrote (decisions.json).
export const Decisions = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      home: Schema.String,
      slug: Schema.String,
      sites: Schema.Array(Schema.String),
      tentative: Schema.Boolean,
      sitesNone: Schema.Boolean,
      links: Schema.Array(Schema.String),
      gist: Schema.String,
    })
  )
)

// What the owner approved: the ADRs to write, in numbering order, and the
// sites that lose their tag. approve writes it; apply reads it.
export const Approved = Schema.fromJsonString(
  Schema.Struct({
    snapshot: Schema.String,
    decisions: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        title: Schema.String,
        home: Schema.String,
        slug: Schema.String,
        sites: Schema.Array(Schema.String),
        gist: Schema.String,
        sitesNone: Schema.Boolean,
      })
    ),
    comments: Schema.Array(Schema.String),
  })
)

export const triageDir = "scripts/adr-triage"

// A script's string options, or its usage line on a bad flag.
export const parseOptions = <
  const O extends Record<string, { type: "string" }>,
>(
  usage: string,
  args: ReadonlyArray<string>,
  options: O
) =>
  Effect.try({
    try: () => parseCliArgs({ args: [...args], options }),
    catch: (error) =>
      new CheckFailed({ summary: usage, findings: [String(error)] }),
  })

// Every scripts/adr-triage/<prefix>*.json, decoded, in name order.
const readAll = Effect.fnUntraced(function* <A>(
  root: string,
  prefix: string,
  schema: Schema.Codec<A, string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(root, triageDir)
  const names = (yield* fs.readDirectory(dir))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
  const values = yield* Effect.forEach(names, (name) =>
    Effect.flatMap(
      fs.readFileString(path.join(dir, name)),
      Schema.decodeEffect(schema)
    )
  )
  return { names, values }
})

// The rows of every manifest (manifest.json, and manifest-catchup.json once
// the catch-up is merged). A site one manifest lists as `gone` loses its row
// in every other, so a changed decision keeps only its catch-up row and a
// removed one keeps none.
export const readManifests = Effect.fnUntraced(function* (root: string) {
  const { names, values } = yield* readAll(root, "manifest", ManifestRows)
  const rows = values.flatMap((manifest) => {
    const gone = new Set(
      values.flatMap((other) => (other === manifest ? [] : (other.gone ?? [])))
    )
    return manifest.rows.filter((row) => !gone.has(row.site))
  })
  return {
    names,
    rows,
    gone: new Set(values.flatMap((manifest) => manifest.gone ?? [])),
  }
})

// Every proposed decision (decisions.json, and any catch-up file beside it).
export const readDecisions = Effect.fnUntraced(function* (root: string) {
  const { names, values } = yield* readAll(root, "decisions", Decisions)
  return { names, decisions: values.flat() }
})
