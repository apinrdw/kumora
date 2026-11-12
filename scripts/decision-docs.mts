// Fails when an ADR directory or a path into one is back in the repo, or when a
// `Decision:` comment breaks its shape: the tag opens a comment line, and the
// decision runs five lines at most from its tag. See docs/agents/domain.md.
// Comments come from parsers: oxc for JS, TS and JSON, `yaml` for YAML. A file
// of any other type is read for ADR links only, never for a Decision.
import { parseSync } from "oxc-parser"
import { Console, Effect, FileSystem, Option, Path } from "effect"
import { Parser } from "yaml"

import { CheckFailed } from "./lib/check.mts"
import { gitLines } from "./lib/command.mts"

const adrDir = /(^|\/)adrs?\//i
const adrLink = /docs\/adrs?\//i
const maxDecisionLines = 5
const tag = "Decision:"
// A tag in comment text; a backticked one is prose about the tag.
const anyTag = new RegExp(String.raw`(?<!\`)\b${tag}`)
const script = /\.[cm]?[jt]sx?$/
const jsx = /\.[jt]sx$/
const json = /\.jsonc?$/
const yaml = /\.ya?ml$/

// A comment as a parser reports it: its text, after `//` or `#` or between
// `/*` and `*/`, and the offset where it opens.
interface Found {
  readonly block: boolean
  readonly start: number
  readonly value: string
}

// The comments in a file: empty when it is not a parsed type, none when oxc
// cannot parse it. The check then names the file and reads nothing from it.
const readComments = Effect.fnUntraced(function* (file: string, text: string) {
  const oxc = (name: string, source: string, shift: number) => {
    const { errors, comments } = parseSync(name, source)
    return errors.length > 0
      ? Option.none()
      : Option.some(
          comments.map((comment) => ({
            block: comment.type === "Block",
            start: comment.start - shift,
            value: comment.value,
          }))
        )
  }
  // CST tokens nest; every comment is a `comment` token somewhere in them.
  const yamlComments = (node: unknown): ReadonlyArray<Found> => {
    if (typeof node !== "object" || node === null) return []
    if ("type" in node && node.type === "comment" && "source" in node)
      return [
        {
          block: false,
          start: "offset" in node ? Number(node.offset) : 0,
          value: String(node.source).slice(1),
        },
      ]
    return Object.values(node).flatMap(yamlComments)
  }
  if (script.test(file)) return oxc(file, text, 0)
  // JSON with comments is a JS expression once wrapped in parentheses; the
  // newline keeps a closing line comment from taking the `)`.
  if (json.test(file)) return oxc(`${file}.js`, `(${text}\n)`, 1)
  if (yaml.test(file))
    return Option.some(yamlComments([...new Parser().parse(text)]))
  return Option.some([])
})

// A comment laid over its source lines. `opens` when only whitespace, or in a
// JSX file a `{`, sits before it on its line. A run of `//` or `#` comments on
// consecutive lines, each opening its line, is one comment.
interface Comment {
  readonly line: number
  readonly opens: boolean
  readonly block: boolean
  readonly lines: Array<string>
}

// A file's `Decision:` comments that sit partway along a line or run too long.
const decisionFindings = Effect.fnUntraced(function* (
  file: string,
  text: string,
  found: ReadonlyArray<Found>
) {
  const comments = found.reduce<Array<Comment>>(
    (all, { block, start, value }) => {
      const line = text.slice(0, start).split("\n").length - 1
      const before = text.slice(text.lastIndexOf("\n", start - 1) + 1, start)
      const opens = (jsx.test(file) ? /^\s*\{?\s*$/ : /^\s*$/).test(before)
      const lines = value
        .split("\n")
        .map((part) => (block ? part.replace(/^\s*\*?/, "") : part).trim())
      const last = all.at(-1)
      if (
        last !== undefined &&
        !block &&
        !last.block &&
        opens &&
        last.opens &&
        last.line + last.lines.length === line
      )
        last.lines.push(...lines)
      else all.push({ line, opens, block, lines })
      return all
    },
    []
  )
  // The lines a decision whose tag is on `lines[at]` runs: to the end of
  // its comment or an empty comment line.
  const runs = (lines: ReadonlyArray<string>, at: number) => {
    const end = lines.findIndex((part, index) => index > at && part === "")
    return (end < 0 ? lines.length : end) - at
  }
  return comments.flatMap(({ line, opens, lines }) =>
    lines.flatMap((part, index) => {
      if (!anyTag.test(part)) return []
      const at = `${file}:${line + index + 1}`
      if (!opens || !part.startsWith(tag))
        return [
          `${at}: ${tag} sits partway along a line; open a comment line with it`,
        ]
      const length = runs(lines, index)
      return length > maxDecisionLines
        ? [
            `${at}: Decision runs ${length} lines; keep ${maxDecisionLines} and link the PR for the rest`,
          ]
        : []
    })
  )
})

export const checkDecisionDocs = Effect.fn("checkDecisionDocs")(function* (
  root: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = yield* gitLines(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    // repos/ is vendored upstream source, which may keep ADRs of its own.
    ":(exclude)repos",
  ])
  const findings = yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      if (adrDir.test(file)) return [`${file}: lives in an ADR directory`]
      // A listed file may be deleted from the working tree.
      const text = yield* Effect.option(
        fs.readFileString(path.resolve(root, file))
      )
      if (Option.isNone(text) || text.value.includes("\0")) return []
      const links = text.value
        .split("\n")
        .flatMap((line, index) =>
          adrLink.test(line)
            ? [`${file}:${index + 1}: points into an ADR directory`]
            : []
        )
      const found = yield* readComments(file, text.value)
      if (Option.isNone(found))
        yield* Console.error(
          `${file}: does not parse, so no Decision in it was read`
        )
      const decisions = Option.isSome(found)
        ? yield* decisionFindings(file, text.value, found.value)
        : []
      return [...links, ...decisions]
    })
  )
  if (findings.flat().length > 0)
    return yield* new CheckFailed({
      summary:
        "This repo keeps decisions as short `Decision:` comments in code, not ADRs (docs/agents/domain.md):",
      findings: findings.flat(),
    })
  yield* Console.log(
    `Checked ${files.length} files: no ADRs, every Decision in shape.`
  )
})
