// Fails when an ADR directory or a path into one is back in the repo, or when a
// `Decision:` comment breaks its shape: the tag opens a comment line, and the
// comment runs five lines at most. See docs/agents/domain.md.
import { Console, Effect, FileSystem, Option, Path } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { gitLines } from "./lib/command.mts"

const adrDir = /(^|\/)adrs?\//i
const adrLink = /docs\/adrs?\//i
const maxDecisionLines = 5
// Built, so this file's own lines carry no tag.
const tag = ["Decision", ":"].join("")
// A tag opens a line comment, a block comment, or a block comment's line.
const decisionTag = new RegExp(String.raw`^\s*(//|#|/\*\*?|\{/\*|\*)\s*${tag}`)
// A tag anywhere else; a backticked one is prose about the tag.
const anyTag = new RegExp(String.raw`(?<!\`)\b${tag}`)
const commentLine = /^\s*(\/\/|#|\*)/
// An empty comment line, or the end of a block comment, closes a decision.
const commentBreak = /^\s*((\/\/|#|\*)\s*$|\*\/|.*\*\/\s*\}?\s*$)/

// A file's `Decision:` comments that open mid-line or run too long. Markdown
// describes the tag rather than using it, so it has none.
const decisionFindings = Effect.fnUntraced(function* (
  file: string,
  lines: ReadonlyArray<string>
) {
  if (file.endsWith(".md")) return []
  // The comment lines a decision opening at `start` runs, its tag included.
  const length = (start: number) => {
    if (commentBreak.test(lines[start] ?? "")) return 1
    let end = start + 1
    while (
      end < lines.length &&
      commentLine.test(lines[end] ?? "") &&
      !commentBreak.test(lines[end] ?? "")
    )
      end++
    // A closing `*/` line with text before it is the decision's last line.
    return end - start + (/\S.*\*\/\s*$/.test(lines[end] ?? "") ? 1 : 0)
  }
  return lines.flatMap((line, index) => {
    if (decisionTag.test(line)) {
      const runs = length(index)
      return runs > maxDecisionLines
        ? [
            `${file}:${index + 1}: Decision runs ${runs} lines; keep ${maxDecisionLines} and link the PR for the rest`,
          ]
        : []
    }
    return anyTag.test(line)
      ? [
          `${file}:${index + 1}: ${tag} starts mid-comment; open its own comment line with it`,
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
