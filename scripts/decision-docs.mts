// Fails when an ADR directory or a path into one is back in the repo.
// Decisions are `Decision:` comments in code; see docs/agents/domain.md.
import { Console, Effect, FileSystem, Option, Path } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { gitLines } from "./lib/command.mts"

const adrDir = /(^|\/)adrs?\//i
const adrLink = /docs\/adrs?\//i

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
      return text.value
        .split("\n")
        .flatMap((line, index) =>
          adrLink.test(line)
            ? [`${file}:${index + 1}: points into an ADR directory`]
            : []
        )
    })
  )
  if (findings.flat().length > 0)
    return yield* new CheckFailed({
      summary:
        "This repo keeps decisions as `Decision:` comments, not ADRs (docs/agents/domain.md):",
      findings: findings.flat(),
    })
  yield* Console.log(`Checked ${files.length} files, no ADRs.`)
})
