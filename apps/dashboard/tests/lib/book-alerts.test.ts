import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  WibDate,
  type BookEvent,
  type BookReadings,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  alertTitle,
  historyOf,
  admitAlert,
  NO_LIMITS,
  ruleMatches,
  withAlert,
  heavySideChanges,
  type Alert,
  type AlertEvent,
  type AlertHistory,
  type HeavySideChange,
  type HeavySideTags,
  type AlertLimits,
  type AlertRule,
  type MatchContext,
} from "@/lib/book-alerts"

const BBCA = StockCode.make("BBCA")
const TLKM = StockCode.make("TLKM")
const T0 = Date.parse("2026-11-18T02:30:00.000Z")

const pulled = (
  code: StockCode,
  at: number,
  over: Partial<{ price: number; lots: number }> = {}
): BookEvent => ({
  kind: "pulled",
  code,
  at: DateTime.makeUnsafe(at),
  side: "bid",
  price: over.price ?? 9_000,
  lots: over.lots ?? 10_000,
  orders: 3,
  ticks: 4,
  approached: false,
})

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "r1",
  kinds: ["pulled"],
  scope: { _tag: "watchlist" },
  minValue: 0,
  ...over,
})

const context = (over: Partial<MatchContext> = {}): MatchContext => ({
  watchlist: new Set([BBCA]),
  excluded: () => false,
  onScanner: () => false,
  ...over,
})

describe("ruleMatches", () => {
  it.effect("matches a watchlist code's event of a chosen kind", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* ruleMatches(rule(), pulled(BBCA, T0), context()))
      assert.isFalse(yield* ruleMatches(rule(), pulled(TLKM, T0), context()))
      assert.isFalse(
        yield* ruleMatches(
          rule({ kinds: ["eaten", "moved"] }),
          pulled(BBCA, T0),
          context()
        )
      )
    })
  )

  it.effect("matches named codes, or every code on the scanner", () =>
    Effect.gen(function* () {
      const named = rule({ scope: { _tag: "codes", codes: [TLKM] } })
      assert.isTrue(yield* ruleMatches(named, pulled(TLKM, T0), context()))
      assert.isFalse(yield* ruleMatches(named, pulled(BBCA, T0), context()))
      const scanner = rule({ scope: { _tag: "scanner" } })
      const onScanner = context({ onScanner: (code) => code === TLKM })
      assert.isTrue(yield* ruleMatches(scanner, pulled(TLKM, T0), onScanner))
      assert.isFalse(yield* ruleMatches(scanner, pulled(BBCA, T0), onScanner))
    })
  )

  it.effect("holds a minimum level value of lots × price × 100", () =>
    Effect.gen(function* () {
      // 10,000 lots at 9,000: Rp9 B.
      const event = pulled(BBCA, T0)
      assert.isTrue(
        yield* ruleMatches(rule({ minValue: 5e9 }), event, context())
      )
      assert.isFalse(
        yield* ruleMatches(rule({ minValue: 20e9 }), event, context())
      )
    })
  )

  it.effect(
    "holds the minimum to the level or wall, never the lots traded or lost",
    () =>
      Effect.gen(function* () {
        const common = {
          code: BBCA,
          at: DateTime.makeUnsafe(T0),
          side: "bid",
          price: 9_000,
          orders: 3,
        } as const
        // Each traded or lost Rp9 B, at a level or wall worth Rp1.8 B.
        const small: ReadonlyArray<BookEvent> = [
          { ...common, kind: "absorbed", lots: 10_000, shown: 2_000 },
          {
            ...common,
            kind: "reloaded",
            lots: 10_000,
            shown: 2_000,
            refills: 1,
            crowd: false,
          },
          {
            ...common,
            kind: "moved",
            lots: 10_000,
            wallLots: 2_000,
            to: 8_975,
          },
        ]
        const kinds = rule({ kinds: ["absorbed", "reloaded", "moved"] })
        for (const event of small) {
          assert.isFalse(
            yield* ruleMatches({ ...kinds, minValue: 5e9 }, event, context()),
            event.kind
          )
          assert.isTrue(
            yield* ruleMatches({ ...kinds, minValue: 1e9 }, event, context()),
            event.kind
          )
        }
        // An eaten level's peak is the level's value.
        const eaten: BookEvent = {
          ...common,
          kind: "eaten",
          lots: 10_000,
          share: 0.8,
        }
        assert.isTrue(
          yield* ruleMatches(
            rule({ kinds: ["eaten"], minValue: 5e9 }),
            eaten,
            context()
          )
        )
      })
  )

  it.effect("never matches an excluded code", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* ruleMatches(
          rule({ scope: { _tag: "codes", codes: [BBCA] } }),
          pulled(BBCA, T0),
          context({ excluded: (code) => code === BBCA })
        )
      )
    })
  )
})

describe("alertTitle", () => {
  it.effect("names the code, the kind and the side", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* alertTitle(pulled(BBCA, T0)),
        "BBCA · Wall pulled on the bid"
      )
      assert.strictEqual(
        yield* alertTitle({ ...pulled(TLKM, T0), side: "offer" }),
        "TLKM · Wall pulled on the offer"
      )
    })
  )
})

// The limits threaded through each admission, as the browser's store keeps
// them.
const makeAlertLimits = Effect.sync(() => {
  let held: AlertLimits = NO_LIMITS
  return {
    admit: (event: AlertEvent, now: number) =>
      Effect.map(admitAlert(held, event, now), (admitted) => {
        held = admitted.limits
        return admitted.verdict
      }),
  }
})

describe("admitting an alert against the alert limits", () => {
  it.effect("lets the same code and kind through once in 2 minutes", () =>
    Effect.gen(function* () {
      const limits = yield* makeAlertLimits
      assert.strictEqual(
        (yield* limits.admit(pulled(BBCA, T0), T0))._tag,
        "Shown"
      )
      assert.strictEqual(
        (yield* limits.admit(pulled(BBCA, T0 + 119_000), T0 + 119_000))._tag,
        "Cooled"
      )
      assert.strictEqual(
        (yield* limits.admit(pulled(TLKM, T0 + 1_000), T0 + 1_000))._tag,
        "Shown"
      )
      assert.strictEqual(
        (yield* limits.admit(pulled(BBCA, T0 + 120_000), T0 + 120_000))._tag,
        "Shown"
      )
    })
  )

  it.effect(
    "shows 6 a minute and folds the rest into one count for that minute",
    () =>
      Effect.gen(function* () {
        const limits = yield* makeAlertLimits
        const codes = Array.from({ length: 9 }, (_, i) =>
          StockCode.make(`AA${String.fromCharCode(65 + i)}`)
        )
        const verdicts = []
        for (const [i, code] of codes.entries())
          verdicts.push(yield* limits.admit(pulled(code, T0 + i), T0 + i))
        assert.deepStrictEqual(
          verdicts.map((verdict) => verdict._tag),
          [
            "Shown",
            "Shown",
            "Shown",
            "Shown",
            "Shown",
            "Shown",
            "Folded",
            "Folded",
            "Folded",
          ]
        )
        const last = verdicts.at(-1)!
        assert.deepStrictEqual(last, {
          _tag: "Folded",
          count: 3,
          since: T0 + 6,
        })
        // A minute after the first: the window has room again, and a later
        // fold starts its own count.
        const later = yield* limits.admit(
          pulled(StockCode.make("ABBA"), T0 + 60_000),
          T0 + 60_000
        )
        assert.strictEqual(later._tag, "Shown")
      })
  )
})

const alert = (key: string, at: number): Alert => ({
  key,
  code: BBCA,
  side: "bid",
  title: "BBCA · Wall pulled on the bid",
  detail: "10 K lots at 9,000",
  at,
})

describe("the day's history", () => {
  it.effect("keeps the newest 200 first", () =>
    Effect.gen(function* () {
      const day = WibDate.make("2026-11-18")
      let history: AlertHistory = { day, alerts: [] }
      for (let i = 0; i < 205; i++)
        history = yield* withAlert(history, alert(`k${i}`, T0 + i), day)
      assert.strictEqual(history.alerts.length, 200)
      assert.strictEqual(history.alerts[0]!.key, "k204")
      assert.strictEqual(history.alerts.at(-1)!.key, "k5")
    })
  )

  it.effect("clears on the next trading day", () =>
    Effect.gen(function* () {
      const day = WibDate.make("2026-11-18")
      const next = WibDate.make("2026-11-19")
      const kept = { day, alerts: [alert("a", T0)] }
      assert.strictEqual((yield* historyOf(kept, day)).alerts.length, 1)
      assert.deepStrictEqual(yield* historyOf(kept, next), {
        day: next,
        alerts: [],
      })
      const added = yield* withAlert(kept, alert("b", T0 + 86_400_000), next)
      assert.deepStrictEqual(
        added.alerts.map((each) => each.key),
        ["b"]
      )
    })
  )
})

// BBCA's readings at `at`: `imbalance` with the bid's and offer's lots per
// order. Lots follow the imbalance over a total of 10,000.
const readingsOf = (
  at: number,
  imbalance: number,
  bidPerOrder: number,
  offerPerOrder: number,
  code: StockCode = BBCA
): BookReadings => ({
  code,
  at: DateTime.makeUnsafe(at),
  imbalance,
  bid: { lots: 5_000 * (1 + imbalance), lotsPerOrder: bidPerOrder },
  offer: { lots: 5_000 * (1 - imbalance), lotsPerOrder: offerPerOrder },
})

const NO_PRICES = () => undefined

// The kinds of the heavy side changes each batch of readings makes, in turn.
const changesOver = Effect.fnUntraced(function* (
  batches: ReadonlyArray<ReadonlyArray<BookReadings>>
) {
  let tags: HeavySideTags = new Map()
  const kinds: Array<ReadonlyArray<string>> = []
  for (const batch of batches) {
    const next = yield* heavySideChanges(tags, batch, NO_PRICES)
    tags = next.tags
    kinds.push(next.changes.map((change) => `${change.side} ${change.kind}`))
  }
  return kinds
})

describe("heavySideChanges", () => {
  it.effect("a tag that appears is a change, and one that stays is not", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* changesOver([
          [readingsOf(T0, 0.2, 10, 10)],
          [readingsOf(T0 + 1_000, -0.72, 22, 118)],
          [readingsOf(T0 + 2_000, -0.8, 22, 120)],
        ]),
        [[], ["offer bigOrders"], []]
      )
    })
  )

  it.effect(
    "the other tag, or the other side's, is a change; none is not",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* changesOver([
            [readingsOf(T0, 0.6, 30, 10)],
            [readingsOf(T0 + 1_000, 0.6, 10, 10)],
            [readingsOf(T0 + 2_000, -0.6, 10, 30)],
            [readingsOf(T0 + 3_000, -0.6, 12, 15)],
            [readingsOf(T0 + 4_000, 0.1, 12, 15)],
          ]),
          [["bid bigOrders"], ["bid smallOrders"], ["offer bigOrders"], [], []]
        )
      })
  )

  it.effect("a code at a limit has no tag", () =>
    Effect.gen(function* () {
      // Readings that would tag, with an empty bid at a price past the
      // lower auto-reject limit.
      const atLimit: BookReadings = {
        ...readingsOf(T0, -0.6, 10, 30),
        bid: { lots: 0, lotsPerOrder: 10 },
      }
      const { changes } = yield* heavySideChanges(new Map(), [atLimit], () => ({
        last: 6_000,
        previousClose: 9_000,
      }))
      assert.deepStrictEqual(changes, [])
    })
  )

  it.effect("each code keeps its own tag", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* changesOver([
          [readingsOf(T0, 0.6, 30, 10)],
          [readingsOf(T0 + 1_000, 0.6, 30, 10, TLKM)],
        ]),
        [["bid bigOrders"], ["bid bigOrders"]]
      )
    })
  )
})

describe("heavy side alerts", () => {
  const change: HeavySideChange = {
    kind: "bigOrders",
    code: BBCA,
    at: DateTime.makeUnsafe(T0),
    side: "offer",
    imbalance: -0.72,
    heavyPerOrder: 118,
    otherPerOrder: 22,
  }

  it.effect("match their kind at any minimum value", () =>
    Effect.gen(function* () {
      const big = rule({ kinds: ["bigOrders"], minValue: 20e9 })
      assert.isTrue(yield* ruleMatches(big, change, context()))
      assert.isFalse(
        yield* ruleMatches(rule({ kinds: ["smallOrders"] }), change, context())
      )
    })
  )

  it.effect("are titled by the heavy side and its orders", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* alertTitle(change),
        "BBCA · Offer-heavy with big orders"
      )
      assert.strictEqual(
        yield* alertTitle({ ...change, kind: "smallOrders", side: "bid" }),
        "BBCA · Bid-heavy with small orders"
      )
    })
  )

  it.effect("share the minute's count with book events", () =>
    Effect.gen(function* () {
      const limits = yield* makeAlertLimits
      const codes = ["AALI", "ADRO", "ANTM", "ASII", "BBNI", "BBRI"]
      for (const [i, code] of codes.entries())
        yield* limits.admit(pulled(StockCode.make(code), T0 + i), T0 + i)
      assert.strictEqual((yield* limits.admit(change, T0 + 10))._tag, "Folded")
    })
  )
})
