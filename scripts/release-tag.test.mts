import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { judgeTag, wibDate } from "./release-tag.mts"

const today = "20261114"
const tag = (name: string, sha = "c0ffee") => ({ name, sha })

const refusal = (
  name: string,
  others: ReadonlyArray<{ name: string; sha: string }>,
  sha = "c0ffee"
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(judgeTag(tag(name, sha), others, today))
    assert.instanceOf(error, CheckFailed)
    return error.summary
  })

describe("judgeTag", () => {
  it.effect("takes today's first Candidate", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* judgeTag(tag("v0.1.10-20261114-1"), [], today),
        "candidate"
      )
    })
  )

  it.effect("counts N across every version tagged that day", () =>
    Effect.gen(function* () {
      const others = [
        tag("v0.1.10-20261114-1", "a"),
        tag("v0.1.11-20261114-2", "b"),
        tag("v0.1.9-20261113-5", "c"),
      ]
      assert.strictEqual(
        yield* judgeTag(tag("v0.1.11-20261114-3"), others, today),
        "candidate"
      )
      assert.match(
        yield* refusal("v0.1.11-20261114-2", others),
        /next Candidate is -3/
      )
      assert.match(
        yield* refusal("v0.1.11-20261114-4", others),
        /next Candidate is -3/
      )
    })
  )

  it.effect("promotes a commit carrying a Candidate of the same version", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* judgeTag(
          tag("v0.1.10-20261114", "a"),
          [tag("v0.1.10-20261114-1", "a")],
          today
        ),
        "production"
      )
    })
  )

  it.effect("refuses Production on a commit no matching Candidate marks", () =>
    Effect.gen(function* () {
      for (const others of [
        [],
        [tag("v0.1.10-20261114-1", "b")],
        [tag("v0.1.9-20261114-1", "a")],
      ])
        assert.match(
          yield* refusal("v0.1.10-20261114", others, "a"),
          /no v0\.1\.10 Candidate/
        )
    })
  )

  it.effect(
    "refuses a version not above Production's, comparing numerically",
    () =>
      Effect.gen(function* () {
        const others = [
          tag("v0.1.10-20261113", "a"),
          tag("v0.1.9-20261101", "z"),
        ]
        for (const name of [
          "v0.1.10-20261114-1",
          "v0.1.9-20261114-1",
          "v0.1.10-20261114",
        ])
          assert.match(
            yield* refusal(name, others),
            /above Production's 0\.1\.10/
          )
        assert.strictEqual(
          yield* judgeTag(tag("v0.2.0-20261114-1"), others, today),
          "candidate"
        )
      })
  )

  it.effect("refuses a date other than today in WIB", () =>
    Effect.gen(function* () {
      assert.match(
        yield* refusal("v0.1.10-20261113-1", []),
        /today in WIB, 20261114/
      )
    })
  )

  it.effect.each([
    "v0.1.10",
    "0.1.10-20261114",
    "v0.1.10-20261114.4669",
    "v0.1.10-20261114-0",
    "v0.1-20261114-1",
  ])("refuses %s, which is no release tag", (name) =>
    Effect.gen(function* () {
      assert.match(yield* refusal(name, []), /a release tag is/)
    })
  )

  it("dates a moment by the WIB calendar", () => {
    assert.strictEqual(wibDate(new Date("2026-11-13T17:30:00Z")), "20261114")
    assert.strictEqual(wibDate(new Date("2026-11-13T16:30:00Z")), "20261113")
  })
})
