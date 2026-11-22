// Exhaustion from hand-made minutes (spec apinrdw/kumora#605, "Testing
// Decisions"): the five-minute push example, each rule failing alone, the
// open's skip, once per extreme, an empty latest minute, the selling mirror
// and relay gaps. Prices sit on the Rp5 tick (500–2,000): Rp100 M is 800
// lots at 1,250.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  WibDate,
  type OrderFlowEvent,
  type RelayGap,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeOrderFlow } from "@/server/market-live/order-flow"

// A Thursday.
const DAY = WibDate.make("2026-11-19")
const CODE = StockCode.make("BBCA")
const wib = (time: string) => Date.parse(`${DAY}T${time}+07:00`)
const MINUTE = 60_000

// One minute's trades: `first` then `second`, splitting `lots` of one
// aggressor side between them. Empty when `lots` is 0.
interface Minute {
  readonly at: string
  readonly first: number
  readonly second: number
  readonly lots: number
}
const m = (at: string, first: number, second: number, lots: number) => ({
  at,
  first,
  second,
  lots,
})

// The push example: 1,200 for a minute, a push to the day's high 1,250 on
// 09:42 (2,400 buy-aggressor lots, 5 ticks wide), and the latest minute
// 09:45 trading 1,240–1,245 on 900 lots.
const PUSH: ReadonlyArray<Minute> = [
  m("09:39", 1200, 1200, 200),
  m("09:40", 1200, 1215, 1000),
  m("09:41", 1215, 1230, 1500),
  m("09:42", 1225, 1250, 2400),
  m("09:43", 1235, 1245, 1250),
  m("09:44", 1240, 1245, 1300),
  m("09:45", 1240, 1245, 900),
]

const replace = (
  minutes: ReadonlyArray<Minute>,
  ...changed: ReadonlyArray<Minute>
) =>
  minutes.map(
    (minute) => changed.find((each) => each.at === minute.at) ?? minute
  )

// The minutes `by` minutes later.
const shifted = (minutes: ReadonlyArray<Minute>, by: number) =>
  minutes.map((minute) => {
    const at = new Date(wib(`${minute.at}:00`) + by * MINUTE + 7 * 3600_000)
    return { ...minute, at: at.toISOString().slice(11, 16) }
  })

let order = 1n
const print = (price: number, lots: number, side: "buy" | "sell") => {
  const value = price * lots * 100
  return {
    closeOrder: order++,
    close: price,
    volume: lots,
    buyValue: side === "buy" ? value : 0,
    sellValue: side === "sell" ? value : 0,
  }
}

// The minutes' trades fed to a fresh state, as the candle book settles
// them, judged at `judgedAt` (WIB), by default 5 s past the last minute's
// close, under `gaps`. A selling run mirrors each price about 1,200.
const run = Effect.fnUntraced(function* (
  minutes: ReadonlyArray<Minute>,
  options: {
    readonly side?: "buy" | "sell"
    readonly code?: StockCode
    readonly judgedAt?: string
    readonly gaps?: ReadonlyArray<RelayGap>
  } = {}
) {
  const side = options.side ?? "buy"
  const code = options.code ?? CODE
  const price = (p: number) => (side === "buy" ? p : 2400 - p)
  const flow = yield* makeOrderFlow(DAY)
  for (const minute of minutes) {
    if (minute.lots === 0) continue
    const at = wib(`${minute.at}:00`)
    const half = Math.floor(minute.lots / 2)
    flow.settled(code, at, print(price(minute.first), half, side))
    flow.settled(
      code,
      at,
      print(price(minute.second), minute.lots - half, side)
    )
  }
  const last = wib(`${minutes.at(-1)!.at}:00`)
  return yield* flow.judge(
    options.judgedAt === undefined
      ? last + MINUTE + 5_000
      : wib(options.judgedAt),
    options.gaps ?? []
  )
})

const exhaustion = (
  at: string,
  fields: Partial<Extract<OrderFlowEvent, { kind: "exhaustion" }>> = {}
): OrderFlowEvent => ({
  kind: "exhaustion",
  code: CODE,
  at: DateTime.makeUnsafe(wib(`${at}:00`)),
  side: "buy",
  price: 1250,
  lots: 900,
  peakLots: 2400,
  ticks: 1,
  widestTicks: 5,
  ...fields,
})

const gap = (from: string, to?: string): RelayGap => ({
  from: DateTime.makeUnsafe(wib(from)),
  ...(to === undefined ? {} : { to: DateTime.makeUnsafe(wib(to)) }),
})

describe("Exhaustion", () => {
  it.effect("fires on the minute after a push that set the day's high", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run(PUSH), [exhaustion("09:45")])
    })
  )

  it.effect("is judged 5 s past the latest minute's close, not before", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run(PUSH, { judgedAt: "09:46:04.999" }), [])
      assert.deepStrictEqual(yield* run(PUSH, { judgedAt: "09:46:05" }), [
        exhaustion("09:45"),
      ])
    })
  )

  it.effect("needs the day's high set by a push minute", () =>
    Effect.gen(function* () {
      // 1,255 traded before the push: the push never set the high.
      const earlier = [m("09:20", 1255, 1200, 100), ...PUSH]
      assert.deepStrictEqual(yield* run(earlier), [])
    })
  )

  it.effect("needs the latest minute within 2 ticks of the high", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* run(replace(PUSH, m("09:45", 1230, 1235, 900))),
        []
      )
    })
  )

  it.effect("needs the latest minute's lots at most half the busiest's", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* run(replace(PUSH, m("09:45", 1240, 1245, 1201))),
        []
      )
      assert.deepStrictEqual(
        yield* run(replace(PUSH, m("09:45", 1240, 1245, 1200))),
        [exhaustion("09:45", { lots: 1200 })]
      )
    })
  )

  it.effect("needs the latest minute to set no new high", () =>
    Effect.gen(function* () {
      const events = yield* run(replace(PUSH, m("09:45", 1250, 1255, 900)))
      assert.notInclude(
        events.map((event) => DateTime.toEpochMillis(event.at)),
        wib("09:45:00")
      )
    })
  )

  it.effect("needs the latest minute's range at most half the widest", () =>
    Effect.gen(function* () {
      // 3 ticks against the widest 5.
      assert.deepStrictEqual(
        yield* run(replace(PUSH, m("09:45", 1235, 1250, 900))),
        []
      )
    })
  )

  it.effect("needs the push's widest minute to span 3 ticks", () =>
    Effect.gen(function* () {
      const narrow = [
        m("09:39", 1200, 1200, 200),
        m("09:40", 1200, 1210, 1000),
        m("09:41", 1210, 1220, 1500),
        m("09:42", 1220, 1230, 2400),
        m("09:43", 1225, 1230, 1250),
        m("09:44", 1225, 1230, 1300),
        m("09:45", 1225, 1225, 900),
      ]
      assert.deepStrictEqual(yield* run(narrow), [])
      // The same push at 3 ticks fires.
      assert.deepStrictEqual(
        yield* run(replace(narrow, m("09:42", 1215, 1230, 2400))),
        [exhaustion("09:45", { price: 1230, ticks: 0, widestTicks: 3 })]
      )
    })
  )

  it.effect("needs Rp100 M of buy-aggressor value on the busiest minute", () =>
    Effect.gen(function* () {
      // 808 lots, half at 1,225 and half at 1,250, are Rp99.99 M.
      const scaled = (lots: number) =>
        PUSH.map((minute) => ({
          ...minute,
          lots: Math.round((minute.lots * lots) / 2400),
        }))
      assert.deepStrictEqual(yield* run(scaled(808)), [])
      assert.deepStrictEqual(yield* run(scaled(809)), [
        exhaustion("09:45", { lots: 303, peakLots: 809 }),
      ])
    })
  )

  it.effect("skips a push with a minute in 09:00–09:04", () =>
    Effect.gen(function* () {
      // Pushes from 09:04 and from 09:05.
      assert.deepStrictEqual(yield* run(shifted(PUSH, -36)), [])
      assert.deepStrictEqual(yield* run(shifted(PUSH, -35)), [
        exhaustion("09:10"),
      ])
    })
  )

  it.effect("skips no minute at Session 2's start", () =>
    Effect.gen(function* () {
      // Session 2 starts 13:30: the push runs 13:30–13:34.
      assert.deepStrictEqual(
        yield* run(shifted(PUSH, 13 * 60 + 30 - (9 * 60 + 40))),
        [exhaustion("13:35")]
      )
    })
  )

  it.effect("needs all six minutes in one session's continuous trading", () =>
    Effect.gen(function* () {
      // Latest 13:31: its push reaches back into the break.
      assert.deepStrictEqual(
        yield* run(shifted(PUSH, 13 * 60 + 26 - (9 * 60 + 40))),
        []
      )
    })
  )

  it.effect("fires once per extreme and again after a new high", () =>
    Effect.gen(function* () {
      const quiet = [...PUSH, m("09:46", 1240, 1245, 800)]
      assert.deepStrictEqual(yield* run(quiet), [exhaustion("09:45")])
      const higher = [
        ...quiet,
        m("09:47", 1245, 1260, 2600),
        m("09:48", 1255, 1260, 500),
      ]
      assert.deepStrictEqual(yield* run(higher), [
        exhaustion("09:45"),
        exhaustion("09:48", {
          price: 1260,
          lots: 500,
          peakLots: 2600,
          ticks: 1,
          widestTicks: 3,
        }),
      ])
    })
  )

  it.effect("sends a late trade's event for a minute already sent once", () =>
    Effect.gen(function* () {
      const flow = yield* makeOrderFlow(DAY)
      const feed = (minutes: ReadonlyArray<Minute>) => {
        for (const minute of minutes) {
          const at = wib(`${minute.at}:00`)
          const half = Math.floor(minute.lots / 2)
          flow.settled(CODE, at, print(minute.first, half, "buy"))
          flow.settled(
            CODE,
            at,
            print(minute.second, minute.lots - half, "buy")
          )
        }
      }
      feed(PUSH)
      assert.deepStrictEqual(yield* flow.judge(wib("09:46:05"), []), [
        exhaustion("09:45"),
      ])
      // 1,255 at 09:44 lands after 09:45 was judged: in order, 09:45 fires
      // at 1,255 and 09:46 stays quiet at that extreme. 09:45's event went
      // out at 1,250 and is not sent again.
      flow.settled(CODE, wib("09:44:00"), print(1255, 1, "buy"))
      feed([m("09:46", 1245, 1245, 800)])
      assert.deepStrictEqual(yield* flow.judge(wib("09:47:05"), []), [])
    })
  )

  it.effect("judges an empty latest minute at the last price", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run(replace(PUSH, m("09:45", 0, 0, 0))), [
        exhaustion("09:45", { lots: 0, ticks: 0 }),
      ])
    })
  )

  it.effect("mirrors at the day's low on selling", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run(PUSH, { side: "sell" }), [
        exhaustion("09:45", { side: "sell", price: 1150 }),
      ])
    })
  )

  it.effect("judges shares only", () =>
    Effect.gen(function* () {
      for (const code of ["BBCA-W", "BUMI-R", "IHSG"])
        assert.deepStrictEqual(
          yield* run(PUSH, { code: StockCode.make(code) }),
          []
        )
    })
  )
})

describe("a day past the baked schedule", () => {
  it.effect("has no continuous minutes, so nothing is judged", () =>
    Effect.gen(function* () {
      const flow = yield* makeOrderFlow(WibDate.make("2025-11-19"))
      flow.settled(
        CODE,
        Date.parse("2025-11-19T09:40:00+07:00"),
        print(1200, 1, "buy")
      )
      assert.deepStrictEqual(
        yield* flow.judge(Date.parse("2025-11-19T10:00:00+07:00"), []),
        []
      )
    })
  )
})

describe("relay gaps", () => {
  it.effect("ignore a 9 s gap in the window", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* run(PUSH, { gaps: [gap("09:42:10", "09:42:19")] }),
        [exhaustion("09:45")]
      )
    })
  )

  it.effect("block the check on a 10 s gap in the window", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* run(PUSH, { gaps: [gap("09:42:10", "09:42:20")] }),
        []
      )
      // One before the window leaves it be.
      assert.deepStrictEqual(
        yield* run(PUSH, { gaps: [gap("09:38:00", "09:38:30")] }),
        [exhaustion("09:45")]
      )
    })
  )

  it.effect("block the check while one is open", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* run(PUSH, {
          judgedAt: "09:46:10",
          gaps: [gap("09:46:02")],
        }),
        []
      )
    })
  )
})
