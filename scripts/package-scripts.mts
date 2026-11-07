// Finds pipelines in an npm script whose failure sh would hide (no pipefail).
// A stage that cannot fail (printf, echo) may feed a pipe; anything else must
// be captured first: out=$(producer) && printf '%s\n' "$out" | consumer.
// Not a shell parser: it reads quotes, escapes, $(...), backticks, and
// redirections >& <& >|. Heredocs, ${...} expansions and case patterns are out
// of scope.

import { Console, Effect, FileSystem, Path, Schema } from "effect"

import { CheckFailed } from "./lib/check.mts"

// The one definition of the allowlist; CODING_STANDARDS.md ("Shell in package scripts") points here.
const safeCommands = ["printf", "echo"]
const safeStage = new RegExp(String.raw`^(${safeCommands.join("|")})(\s|$)`)

const singleQuoted = String.raw`'[^']*'`
const escaped = String.raw`\\.`
// A $(...) body may hold quotes, escapes, and one level of nested parens.
const substitutionBody = String.raw`(?:${singleQuoted}|"(?:${escaped}|[^"\\])*"|${escaped}|[^()'"\\]|\([^()]*\))*`
const dollarSubstitution = String.raw`\$\(${substitutionBody}\)`
const substitution = new RegExp(
  String.raw`\$\((${substitutionBody})\)|\x60([^\x60]*)\x60`,
  "g"
)
const backtickSubstitution = String.raw`\x60[^\x60]*\x60`
// One match per single-quoted string, double-quoted string (which may hold a $(...)
// or `...` with its own quotes), escaped character, substitution, redirection, or
// run of plain text. Operators fall through to the plain text.
const shellToken = new RegExp(
  String.raw`${singleQuoted}|"(?:${escaped}|${dollarSubstitution}|${backtickSubstitution}|[^"\\])*"|${escaped}|${dollarSubstitution}|${backtickSubstitution}|[<>]&|>\||[^'"\\$\x60<>]+|[\s\S]`,
  "g"
)
const listSeparator = /&&|\|\||[;&\n]/

// Operator characters inside quotes, escapes, substitutions and redirections are text.
const masked = { "|": "\uE000", "&": "\uE001", ";": "\uE002", "\n": "\uE003" }
const mask = (token: string) =>
  token.replace(/[|&;\n]/g, (ch) => masked[ch as keyof typeof masked])
const unmask = (text: string) =>
  text.replace(/[\uE000-\uE003]/g, (ch) => "|&;\n"[ch.charCodeAt(0) - 0xe000])

const isSyntax = (token: string) =>
  /^[^'"\\$`]/.test(token) && !/^([<>]&|>\|)/.test(token)

// Command lists that run inside a token: a bare $(...) or `...`, or those inside double quotes.
function nestedCommands(token: string): string[] {
  if (token.startsWith("$(")) return [token.slice(2, -1)]
  if (token.startsWith("`")) return [token.slice(1, -1)]
  if (token.startsWith('"')) {
    const unescaped = token.replace(/\\./g, "__")
    return [...unescaped.matchAll(substitution)].map(
      ([, dollar, tick]) => dollar ?? tick
    )
  }
  return []
}

const hidesFailure = (stages: string[]) =>
  stages.length > 1 &&
  !stages.slice(0, -1).every((stage) => safeStage.test(stage))

export const unguardedPipes: (command: string) => Effect.Effect<Array<string>> =
  Effect.fnUntraced(function* (command) {
    const tokens = [...command.matchAll(shellToken)].map(([token]) => token)
    const nested = yield* Effect.forEach(
      tokens.flatMap(nestedCommands),
      unguardedPipes
    )
    const flat = tokens
      .map((token) => (isSyntax(token) ? token : mask(token)))
      .join("")
    const pipelines = flat
      .split(listSeparator)
      .map((list) => list.split("|").map((s) => s.trim()))
    return [
      ...nested.flat(),
      ...pipelines
        .filter(hidesFailure)
        .map((stages) => unmask(stages.join(" | "))),
    ]
  })

const Scripts = Schema.fromJsonString(
  Schema.Struct({
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  })
)

// Each "dir/*" glob in pnpm-workspace.yaml names a parent of workspaces.
const workspaceDirs = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const yaml = yield* fs.readFileString(path.join(root, "pnpm-workspace.yaml"))
  const parents = [...yaml.matchAll(/^\s+-\s+"?([\w./-]+)\/\*"?\s*$/gm)].map(
    ([, parent]) => path.join(root, parent as string)
  )
  const dirs = yield* Effect.forEach(parents, (parent) =>
    Effect.map(
      Effect.orElseSucceed(fs.readDirectory(parent), () => []),
      (names) => names.map((name) => path.join(parent, name))
    )
  )
  return dirs.flat()
})

export const checkPackageScripts = Effect.fn("checkPackageScripts")(function* (
  root: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const manifests = yield* Effect.filter(
    [root, ...(yield* workspaceDirs(root))].map((dir) =>
      path.join(dir, "package.json")
    ),
    (file) => fs.exists(file)
  )
  const offenders = yield* Effect.forEach(manifests, (file) =>
    Effect.gen(function* () {
      const { scripts = {} } = yield* Schema.decodeEffect(Scripts)(
        yield* fs.readFileString(file)
      )
      const found = yield* Effect.forEach(
        Object.entries(scripts),
        ([name, command]) =>
          Effect.map(unguardedPipes(command), (pipelines) =>
            pipelines.map(
              (pipeline) =>
                `${path.relative(root, file)} "${name}": ${pipeline}`
            )
          )
      )
      return found.flat()
    })
  )
  if (offenders.flat().length > 0)
    return yield* new CheckFailed({
      summary: `Pipes hide the producer's failure in npm scripts (sh has no pipefail). Only ${safeCommands.join(" or ")} may feed a pipe; capture anything else first:\n  out=$(producer) && printf '%s\\n' "$out" | consumer`,
      findings: offenders.flat(),
    })
  yield* Console.log(
    `Checked ${manifests.length} package.json files, no unguarded pipes.`
  )
})
