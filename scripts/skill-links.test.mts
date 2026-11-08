import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { TestConsole } from "effect/testing"

import { CheckFailed } from "./lib/check.mts"
import { memoryFileSystem } from "./lib/testing.mts"
import { checkSkillLinks } from "./skill-links.mts"

const repo = (files: Record<string, string>) =>
  Layer.merge(memoryFileSystem(files), Path.layer)

describe("checkSkillLinks", () => {
  it.effect("passes when every relative link resolves", () =>
    Effect.gen(function* () {
      yield* checkSkillLinks("/repo")
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Checked 2 files, all links resolve.",
      ])
    }).pipe(
      Effect.provide(
        repo({
          "/repo/AGENTS.md":
            "See [the brief](docs/brief.md#top) and [Effect](https://effect.website).",
          "/repo/docs/brief.md": "",
          "/repo/.claude/skills/x/SKILL.md": "[up](../../../AGENTS.md)",
          "/repo/.claude/skills/x/notes.txt": "[gone](missing.md)",
        })
      )
    )
  )

  it.effect("fails with CheckFailed naming each broken link", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(checkSkillLinks("/repo"))
      assert.instanceOf(error, CheckFailed)
      assert.deepStrictEqual(error.findings, [
        "AGENTS.md: docs/gone.md",
        ".claude/skills/x/SKILL.md: ./missing",
      ])
    }).pipe(
      Effect.provide(
        repo({
          "/repo/AGENTS.md": "[gone](docs/gone.md)",
          "/repo/.claude/skills/x/SKILL.md": "[missing](./missing)",
        })
      )
    )
  )
})
