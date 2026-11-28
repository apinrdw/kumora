import { assert, describe, it } from "@effect/vitest"
import { Command } from "effect/cli"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestClock, TestConsole } from "effect/testing"

import type { Branch } from "../src/github.ts"
import type { Stacks } from "../src/stacks.ts"
import { teardownCommand } from "../src/teardown-command.ts"
import {
  cliTestLayer,
  fakeGitHub,
  fakeStacks,
  fakeStoredStages,
} from "./support.ts"

// Previews of live branches, worked out by hand (see target.test.ts).
const live = "feature-login-df7c7a" // feature/login
const gone = "feat-gone-e622ed" // feat/gone, deleted
const otherGone = "fix-old-push-00ea70" // fix/old-push, deleted
const merged = "feat-merged-7b0378" // feat/merged
const fresh = "feat-673-fresh-b32424" // feat/673-fresh
const edge = "feat-673-edge-d8f69f" // feat/673-edge
const idle = "feat-673-idle-d0c1b6" // feat/673-idle
const radar = "prototype-radar-ad584f" // prototype/radar
const sketch = "prototype-sketch-7fab23" // prototype/sketch

// The sweep runs at this time by the TestClock.
const NOW = DateTime.makeUnsafe("2026-11-27T20:00:00Z")

// A live branch whose head commit is `age` old at NOW.
const branch = (
  name: string,
  pullRequests: Branch["pullRequests"],
  age: Duration.Input = 0
): Branch => ({
  name,
  pullRequests,
  headCommitDate: DateTime.subtractDuration(NOW, age),
})

const login = branch("feature/login", "open")

const sweep = (
  args: ReadonlyArray<string>,
  options: {
    readonly stacks: Layer.Layer<Stacks>
    readonly stored: Parameters<typeof fakeStoredStages>[0]
    readonly branches: ReadonlyArray<Branch>
    readonly at?: DateTime.Utc
  }
) =>
  TestClock.setTime(DateTime.toEpochMillis(options.at ?? NOW)).pipe(
    Effect.andThen(
      Command.runWith(teardownCommand, { version: "test" })(["sweep", ...args])
    ),
    Effect.provide(
      Layer.mergeAll(
        cliTestLayer,
        options.stacks,
        fakeStoredStages(options.stored),
        fakeGitHub(options.branches)
      )
    )
  )

describe("teardown sweep", () => {
  it.effect(
    "destroys every app of a Preview whose branch is gone and keeps a live branch's",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        yield* sweep([], {
          stacks: stacks.layer,
          stored: { web: [live, gone], dashboard: [live, gone] },
          branches: [branch("staging", "none"), login],
        })
        assert.deepStrictEqual(stacks.destroyed, [
          ["web", gone],
          ["dashboard", gone],
        ])
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          `destroyed ${gone} (branch gone)`,
          `kept ${live} (open PR)`,
        ])
      })
  )

  it.effect("keeps a Preview with an open PR however old its head commit", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      yield* sweep([], {
        stacks: stacks.layer,
        stored: { web: [live], dashboard: [live] },
        branches: [branch("feature/login", "open", "60 days")],
      })
      assert.deepStrictEqual(stacks.destroyed, [])
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        `kept ${live} (open PR)`,
      ])
    })
  )

  it.effect(
    "keeps a Prototype branch's Preview whatever its age or PR history",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        yield* sweep([], {
          stacks: stacks.layer,
          stored: { web: [radar, sketch] },
          branches: [
            branch("prototype/radar", "closed", "60 days"),
            branch("prototype/sketch", "none", "60 days"),
          ],
        })
        assert.deepStrictEqual(stacks.destroyed, [])
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          `kept ${radar} (prototype branch)`,
          `kept ${sketch} (prototype branch)`,
        ])
      })
  )

  it.effect(
    "destroys a Preview whose latest PR is merged or closed at once, even after a fresh push",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        yield* sweep([], {
          stacks: stacks.layer,
          stored: { web: [merged], dashboard: [merged] },
          branches: [branch("feat/merged", "closed", "1 minute")],
        })
        assert.deepStrictEqual(stacks.destroyed, [
          ["web", merged],
          ["dashboard", merged],
        ])
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          `destroyed ${merged} (PR closed)`,
        ])
      })
  )

  it.effect(
    "keeps a no-PR branch's Preview in its 3-day grace and destroys it once idle",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        yield* sweep([], {
          stacks: stacks.layer,
          stored: { web: [fresh, idle] },
          branches: [
            branch("feat/673-fresh", "none", "1 day"),
            branch("feat/673-idle", "none", "10 days"),
          ],
        })
        assert.deepStrictEqual(stacks.destroyed, [
          ["web", idle],
          ["dashboard", idle],
        ])
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          `kept ${fresh} (no PR, in grace)`,
          `destroyed ${idle} (no PR, idle)`,
        ])
      })
  )

  it.effect(
    "keeps a no-PR Preview whose head is exactly 3 days old, and destroys it 1 ms later",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        const options = {
          stacks: stacks.layer,
          stored: { web: [edge] },
          branches: [branch("feat/673-edge", "none", "3 days")],
        }
        yield* sweep([], options)
        assert.deepStrictEqual(stacks.destroyed, [])
        yield* sweep([], {
          ...options,
          at: DateTime.addDuration(NOW, "1 millis"),
        })
        assert.deepStrictEqual(stacks.destroyed, [
          ["web", edge],
          ["dashboard", edge],
        ])
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          `kept ${edge} (no PR, in grace)`,
          `destroyed ${edge} (no PR, idle)`,
        ])
      })
  )

  it.effect("a dry run destroys nothing and prints would-destroy lines", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      yield* sweep(["--dry-run"], {
        stacks: stacks.layer,
        stored: { web: [gone, live], dashboard: [otherGone] },
        branches: [login],
      })
      assert.deepStrictEqual(stacks.destroyed, [])
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        `would destroy ${gone} (branch gone)`,
        `kept ${live} (open PR)`,
        `would destroy ${otherGone} (branch gone)`,
      ])
    })
  )

  it.effect(
    "never destroys a Release stage, the Test stage or a name that isn't a Preview",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        yield* sweep([], {
          stacks: stacks.layer,
          stored: {
            web: ["production", "staging", "test", "live_jarvis"],
            dashboard: ["dev_jarvis", "production"],
          },
          branches: [],
        })
        assert.deepStrictEqual(stacks.destroyed, [])
        assert.deepStrictEqual(yield* TestConsole.logLines, [])
      })
  )

  it.effect("destroys a Preview stored for only one app across every app", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      yield* sweep([], {
        stacks: stacks.layer,
        stored: { dashboard: [gone] },
        branches: [],
      })
      assert.deepStrictEqual(stacks.destroyed, [
        ["web", gone],
        ["dashboard", gone],
      ])
    })
  )

  it.effect(
    "still destroys the other app and the other Previews when one app fails, then lists it",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks({
          failing: { web: "state store unreachable" },
        })
        const error = yield* Effect.flip(
          sweep([], {
            stacks: stacks.layer,
            stored: { web: [gone, otherGone, live] },
            branches: [login],
          })
        )
        assert.deepStrictEqual(stacks.destroyed, [
          ["dashboard", gone],
          ["dashboard", otherGone],
        ])
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          `failed to destroy ${gone} (branch gone)`,
          `kept ${live} (open PR)`,
          `failed to destroy ${otherGone} (branch gone)`,
        ])
        assert.strictEqual(error._tag, "SweepFailed")
        assert.strictEqual(
          error.message,
          [
            "Sweeping Previews failed:",
            `  ${gone} web: state store unreachable`,
            `  ${otherGone} web: state store unreachable`,
          ].join("\n")
        )
      })
  )

  it.effect("does nothing on an empty state store", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      yield* sweep([], { stacks: stacks.layer, stored: {}, branches: [] })
      assert.deepStrictEqual(stacks.destroyed, [])
      assert.deepStrictEqual(yield* TestConsole.logLines, [])
    })
  )
})
