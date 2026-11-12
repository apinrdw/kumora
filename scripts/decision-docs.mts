// Fails when an ADR directory or a path into one is back in the repo, or when a
// `Decision:` comment breaks its shape: the tag opens a comment line, and the
// comment runs five lines at most. See docs/agents/domain.md.
import { Array as Arr, Console, Effect, FileSystem, Option, Path } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { gitLines } from "./lib/command.mts"

const adrDir = /(^|\/)adrs?\//i
const adrLink = /docs\/adrs?\//i
const maxDecisionLines = 5
// Built, so this file's own lines carry no tag.
const tag = ["Decision", ":"].join("")
// A tag in comment text; a backticked one is prose about the tag.
const anyTag = new RegExp(String.raw`(?<!\`)\b${tag}`)
const lineComment = /^\s*(\/\/|#|--(?=\s|$))/
// A comment after code on the same line.
const trailingComment = /\s(?:\/\/|#|--)\s(.*)$/
// Block comments open at a line's start and run to their closer.
const blockComments = [
  { open: /^\s*\{?\s*\/\*\*?/, close: "*/" },
  { open: /^\s*<!--/, close: "-->" },
]

// The comment text on one line. `own` when the comment opens the line,
// `ends` when the line closes its block comment.
interface Comment {
  readonly text: string
  readonly own: boolean
  readonly ends: boolean
}
// The closer of the block comment open after a line, if one is.
type Open = string | undefined

// A file's `Decision:` comments that open mid-comment or run too long.
// Markdown describes the tag rather than using it, so it has none.
const decisionFindings = Effect.fnUntraced(function* (
  file: string,
  lines: ReadonlyArray<string>
) {
  if (file.endsWith(".md")) return []
  // The text of a block comment's line up to `close`, which may end it here.
  const blockLine = (rest: string, close: string): readonly [Open, Comment] => {
    const at = rest.indexOf(close)
    const text = (at < 0 ? rest : rest.slice(0, at)).replace(/^\s*\*?/, "")
    return [
      at < 0 ? close : undefined,
      { text: text.trim(), own: true, ends: at >= 0 },
    ]
  }
  const codeLine = (line: string): readonly [Open, Comment | undefined] => {
    const block = blockComments.find(({ open }) => open.test(line))
    if (block !== undefined)
      return blockLine(line.replace(block.open, ""), block.close)
    const trailing = trailingComment.exec(line)?.[1]
    return [
      undefined,
      trailing === undefined
        ? undefined
        : { text: trailing, own: false, ends: false },
    ]
  }
  const classify = (
    open: Open,
    line: string
  ): readonly [Open, Comment | undefined] => {
    if (open !== undefined) return blockLine(line, open)
    const marker = lineComment.exec(line)?.[0]
    if (marker === undefined) return codeLine(line)
    return [
      undefined,
      { text: line.slice(marker.length).trim(), own: true, ends: false },
    ]
  }
  const closed: Open = undefined
  const [, comments] = Arr.mapAccum(lines, closed, classify)
  // An empty comment line, a code line, or the end of its block closes a
  // decision.
  const continues = (index: number) =>
    comments[index - 1]?.ends === false &&
    comments[index]?.own === true &&
    comments[index]?.text !== ""
  // The comment lines a decision opening at `start` runs, its tag included.
  const length = (start: number) => {
    let end = start + 1
    while (continues(end)) end++
    return end - start
  }
  return comments.flatMap((comment, index) => {
    if (comment === undefined || !anyTag.test(comment.text)) return []
    if (!comment.own || !comment.text.startsWith(tag))
      return [
        `${file}:${index + 1}: ${tag} starts mid-comment; open its own comment line with it`,
      ]
    const runs = length(index)
    return runs > maxDecisionLines
      ? [
          `${file}:${index + 1}: Decision runs ${runs} lines; keep ${maxDecisionLines} and link the PR for the rest`,
        ]
      : []
  })
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
      const lines = text.value.split("\n")
      const links = lines.flatMap((line, index) =>
        adrLink.test(line)
          ? [`${file}:${index + 1}: points into an ADR directory`]
          : []
      )
      return [...links, ...(yield* decisionFindings(file, lines))]
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
