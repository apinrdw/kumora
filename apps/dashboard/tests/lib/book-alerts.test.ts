import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate, type BookEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  alertTitle,
  historyOf,
  admitAlert,
  NO_LIMITS,
  ruleMatches,
  withAlert,
  type Alert,
  type AlertHistory,
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
const makeGate = Effect.sync(() => {
  let limits: AlertLimits = NO_LIMITS
  return {
    admit: (event: BookEvent, now: number) =>
      Effect.map(admitAlert(limits, event, now), (admitted) => {
        limits = admitted.limits
        return admitted.verdict
      }),
  }
})

describe("the alert gate", () => {
  it.effect("lets the same code and kind through once in 2 minutes", () =>
    Effect.gen(function* () {
      const gate = yield* makeGate
      assert.strictEqual(
        (yield* gate.admit(pulled(BBCA, T0), T0))._tag,
        "Shown"
      )
      assert.strictEqual(
        (yield* gate.admit(pulled(BBCA, T0 + 119_000), T0 + 119_000))._tag,
        "Cooled"
      )
      assert.strictEqual(
        (yield* gate.admit(pulled(TLKM, T0 + 1_000), T0 + 1_000))._tag,
        "Shown"
      )
      assert.strictEqual(
        (yield* gate.admit(pulled(BBCA, T0 + 120_000), T0 + 120_000))._tag,
        "Shown"
      )
    })
  )

  it.effect(
    "shows 6 a minute and folds the rest into one count for that minute",
    () =>
      Effect.gen(function* () {
        const gate = yield* makeGate
        const codes = Array.from({ length: 9 }, (_, i) =>
          StockCode.make(`AA${String.fromCharCode(65 + i)}`)
        )
        const verdicts = []
        for (const [i, code] of codes.entries())
          verdicts.push(yield* gate.admit(pulled(code, T0 + i), T0 + i))
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
        const later = yield* gate.admit(
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
