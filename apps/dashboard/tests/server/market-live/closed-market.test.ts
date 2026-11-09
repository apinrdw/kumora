import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { closedMarketAt } from "@/server/market-live/closed-market"

const at = (wib: string) => closedMarketAt(DateTime.makeUnsafe(`${wib}+07:00`))

describe("the shut market the page opens", () => {
  it.effect("a Saturday opens Friday at its close, closed until Monday", () =>
    Effect.gen(function* () {
      const answer = yield* at("2026-11-14T10:00:00")
      assert.deepStrictEqual(answer.closed, {
        day: WibDate.make("2026-11-13"),
        phase: "closed",
        nextOpen: Date.parse("2026-11-16T08:45:00+07:00"),
      })
      // Looked at again at 17:00, which changes nothing on a weekend.
      assert.strictEqual(answer.changesIn, 7 * 3_600_000)
    })
  )

  it.effect("a holiday reads holiday", () =>
    Effect.gen(function* () {
      const answer = yield* at("2026-08-17T10:00:00")
      assert.strictEqual(answer.closed?.phase, "holiday")
      assert.strictEqual(answer.closed?.day, "2026-08-14")
    })
  )

  it.effect("a trading day goes live at 08:40 and recorded at 17:00", () =>
    Effect.gen(function* () {
      const early = yield* at("2026-11-09T08:30:00")
      assert.strictEqual(early.closed?.day, "2026-11-06")
      assert.strictEqual(early.changesIn, 10 * 60_000)
      const live = yield* at("2026-11-09T16:30:00")
      assert.isUndefined(live.closed)
      assert.strictEqual(live.changesIn, 30 * 60_000)
      const sealed = yield* at("2026-11-09T17:00:00")
      assert.strictEqual(sealed.closed?.day, "2026-11-09")
    })
  )

  it.effect("a year past the baked schedule shows the live page", () =>
    Effect.gen(function* () {
      assert.isUndefined((yield* at("2031-01-04T10:00:00")).closed)
    })
  )
})
