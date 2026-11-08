import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { TestConsole } from "effect/testing"

import { checkDecisionDocs } from "./decision-docs.mts"
import { CheckFailed } from "./lib/check.mts"
import { memoryFileSystem, recordingSpawner } from "./lib/testing.mts"

// Built, so this file's own lines don't point into an ADR directory.
const adrDocs = ["docs", "adr"].join("/")

// A repo whose index lists the files given, plus `unreadable` ones that are
// listed but not on disk.
const repo = (
  files: Record<string, string>,
  unreadable: ReadonlyArray<string> = []
) => {
  const index = recordingSpawner(() => ({
    stdout: [...Object.keys(files), ...unreadable]
      .map((file) => `${file}\n`)
      .join(""),
  }))
  const absolute = Object.fromEntries(
    Object.entries(files).map(([file, text]) => [`/repo/${file}`, text])
  )
  return {
    index,
    layer: Layer.mergeAll(index.layer, memoryFileSystem(absolute), Path.layer),
  }
}

describe("checkDecisionDocs", () => {
  it.effect("passes on a repo with no ADRs", () => {
    const { index, layer } = repo({
      "README.md": "Decisions are `Decision:` comments.",
      "assets/logo.png": `\0PNG ${adrDocs}/ inside binary`,
    })
    return Effect.gen(function* () {
      yield* checkDecisionDocs("/repo")
      assert.include(index.calls[0]?.args ?? [], ":(exclude)repos")
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Checked 2 files, no ADRs.",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "fails with CheckFailed naming ADR files and links into them",
    () => {
      const { layer } = repo({
        [`${adrDocs}/0001-use-effect.md`]: "# Use Effect",
        "AGENTS.md": `intro\nSee ${adrDocs}s/0001.md for why.`,
      })
      return Effect.gen(function* () {
        const error = yield* Effect.flip(checkDecisionDocs("/repo"))
        assert.instanceOf(error, CheckFailed)
        assert.deepStrictEqual(error.findings, [
          `${adrDocs}/0001-use-effect.md: lives in an ADR directory`,
          "AGENTS.md:2: points into an ADR directory",
        ])
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("skips a listed file it cannot read", () => {
    const { layer } = repo({ "README.md": "" }, ["docs/adr-notes.md"])
    return Effect.gen(function* () {
      yield* checkDecisionDocs("/repo")
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Checked 2 files, no ADRs.",
      ])
    }).pipe(Effect.provide(layer))
  })
})
