import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { judgeTag, releaseVersionFiles, wibDate } from "./release-tag.mts"

const today = "20261114"
const tag = (name: string, sha = "c0ffee") => ({ name, sha })
const at = (version: string) =>
  releaseVersionFiles.map((file) => [file, version] as const)

const refusal = (
  name: string,
  released: ReadonlyArray<{ name: string; sha: string }>,
  versions = at(name.slice(1).split("-")[0] ?? ""),
  day: string | undefined = today
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      judgeTag(tag(name), released, versions, day)
    )
    assert.instanceOf(error, CheckFailed)
    return [error.summary, ...error.findings].join("\n")
  })

describe("judgeTag", () => {
  it.effect("takes a tag naming its commit's Release version", () =>
    judgeTag(tag("v0.1.10-20261114"), [], at("0.1.10"), today)
  )

  it.effect("refuses a tag its commit's Release version doesn't match", () =>
    Effect.gen(function* () {
      const message = yield* refusal(
        "v0.1.10-20261114",
        [],
        [
          ["package.json", "0.1.10"],
          ["apps/dashboard/package.json", "0.1.9"],
          ["apps/web/package.json", "0.1.10"],
        ]
      )
      assert.match(message, /Release version is not 0\.1\.10/)
      assert.match(message, /apps\/dashboard\/package\.json: 0\.1\.9/)
      assert.notMatch(message, /apps\/web/)
    })
  )

  it.effect(
    "refuses a version not above Production's, comparing numerically",
    () =>
      Effect.gen(function* () {
        const released = [
          tag("v0.1.10-20261113", "a"),
          tag("v0.1.9-20261101", "z"),
        ]
        for (const name of ["v0.1.9-20261114", "v0.1.10-20261114"])
          assert.match(
            yield* refusal(name, released),
            /above Production's 0\.1\.10/
          )
        yield* judgeTag(tag("v0.2.0-20261114"), released, at("0.2.0"), today)
      })
  )

  it.effect("ignores retired -N tags on main when finding Production's", () =>
    judgeTag(
      tag("v0.1.10-20261114"),
      [tag("v0.1.9-20261113", "a"), tag("v0.1.12-20261113-7", "b")],
      at("0.1.10"),
      today
    )
  )

  it.effect("refuses a date other than today in WIB when pushed", () =>
    Effect.gen(function* () {
      assert.match(
        yield* refusal("v0.1.10-20261113", []),
        /today in WIB, 20261114/
      )
    })
  )

  it.effect("takes a Release on a tag pushed an earlier day", () =>
    judgeTag(tag("v0.1.10-20261113"), [], at("0.1.10"), undefined)
  )

  it.effect.each([
    "v0.1.10",
    "0.1.10-20261114",
    "v0.1.10-20261114.4669",
    "v0.1.10-20261114-1",
    "v0.1-20261114",
  ])("refuses %s, which is no Release tag", (name) =>
    Effect.gen(function* () {
      assert.match(yield* refusal(name, []), /a Release tag is/)
    })
  )

  it.effect("dates a moment by the WIB calendar", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* wibDate(new Date("2026-11-13T17:30:00Z")),
        "20261114"
      )
      assert.strictEqual(
        yield* wibDate(new Date("2026-11-13T16:30:00Z")),
        "20261113"
      )
    })
  )
})
