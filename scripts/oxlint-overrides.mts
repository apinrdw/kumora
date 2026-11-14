// Fails when an .oxlintrc.json override's no-restricted-imports omits a root
// path or pattern. An override's rule options replace the root ones rather
// than merge, so an override that bans more imports must restate the root bans
// or silently drop them in its files.
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"

import { CheckFailed } from "./lib/check.mts"

const rule = "no-restricted-imports"

// Root paths an override may leave out, and the only files it may do so for.
// The two bridges (packages/server/src/workflow.ts says why there are two) are
// the only modules that may reach cloudflare:workers.
const allowedOmissions: Readonly<Record<string, ReadonlyArray<string>>> = {
  "cloudflare:workers": [
    "packages/server/src/bridge.ts",
    "packages/server/src/workflow.ts",
  ],
}

const Pattern = Schema.Struct({
  group: Schema.optional(Schema.Array(Schema.String)),
  regex: Schema.optional(Schema.String),
})
const ImportBans = Schema.Tuple([
  Schema.String,
  Schema.Struct({
    paths: Schema.optional(
      Schema.Array(Schema.Struct({ name: Schema.String }))
    ),
    patterns: Schema.optional(Schema.Array(Pattern)),
  }),
])
const Rules = Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
const Config = Schema.Struct({
  rules: Rules,
  overrides: Schema.optional(
    Schema.Array(
      Schema.Struct({ files: Schema.Array(Schema.String), rules: Rules })
    )
  ),
})

// .oxlintrc.json is JSONC: drop comments and trailing commas outside strings.
const jsonc = Effect.fnUntraced(function* (text: string) {
  return text
    .replace(
      /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (_, s) => s ?? ""
    )
    .replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (_, s, close) => s ?? close)
})

const describePattern = Effect.fnUntraced(function* ({
  group,
  regex,
}: typeof Pattern.Type) {
  return group === undefined
    ? `regex ${regex}`
    : `group ${JSON.stringify(group)}`
})

export const checkOxlintOverrides = Effect.fn("checkOxlintOverrides")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* fs.readFileString(path.join(root, ".oxlintrc.json"))
    const config = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Config)
    )(yield* jsonc(text))
    const [, rootBans] = yield* Schema.decodeUnknownEffect(ImportBans)(
      config.rules?.[rule]
    )
    const overrides = config.overrides ?? []
    const rootPatterns = yield* Effect.forEach(
      rootBans.patterns ?? [],
      describePattern
    )
    const perOverride = yield* Effect.forEach(
      overrides,
      Effect.fnUntraced(function* ({ files, rules }, index) {
        if (rules === undefined || !(rule in rules)) return []
        const where = `overrides[${index}] (${files.join(", ")})`
        const bans = Schema.decodeUnknownOption(ImportBans)(rules[rule])
        if (Option.isNone(bans))
          return [`${where}: sets ${rule} without the root paths and patterns`]
        const [, { paths = [], patterns = [] }] = bans.value
        const names = new Set(paths.map(({ name }) => name))
        const restated = new Set(
          yield* Effect.forEach(patterns, describePattern)
        )
        const missingPaths = (rootBans.paths ?? [])
          .map(({ name }) => name)
          .filter((name) => !names.has(name))
          .filter(
            (name) =>
              !files.every((file) => allowedOmissions[name]?.includes(file))
          )
          .map((name) => `${where}: missing path "${name}"`)
        const missingPatterns = rootPatterns
          .filter((pattern) => !restated.has(pattern))
          .map((pattern) => `${where}: missing pattern ${pattern}`)
        return [...missingPaths, ...missingPatterns]
      })
    )
    const findings = perOverride.flat()
    if (findings.length > 0)
      return yield* new CheckFailed({
        summary: `An override's ${rule} replaces the root options, so it must restate every root path and pattern (.oxlintrc.json):`,
        findings,
      })
    yield* Console.log(
      `Checked ${overrides.length} overrides, each restates the root import bans.`
    )
  }
)
