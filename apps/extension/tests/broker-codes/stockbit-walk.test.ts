import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  WibDate,
  decodeBrokerCodesBatch,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type TradeCodes,
} from "@workspace/relay"
import { Clock, Deferred, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeAjaibWalk } from "../../src/worker/broker-codes/ajaib-walk.ts"
import { makeExtraTarget } from "../../src/worker/broker-codes/extra-target.ts"
import {
  makeHistoryWalk,
  type HistoryPosition,
} from "../../src/worker/broker-codes/history.ts"
import type { PostOutcome } from "../../src/worker/broker-codes/poster.ts"
import { makeRunQueue } from "../../src/worker/broker-codes/run-queue.ts"
import {
  makeStockbitWalk,
  stockbitCatchUp,
} from "../../src/worker/broker-codes/stockbit-walk.ts"
import type { Answer, TabRequest } from "../../src/worker/broker.ts"
import { makePacer } from "../../src/worker/pacer.ts"
import { DashboardOrigin } from "../../src/worker/settings.ts"

const DAY = WibDate.make("2026-11-12")
const wib = (date: string, time: string) => Date.parse(`${date}T${time}+07:00`)
const N = 2_345

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("=", "")
// The Stockbit page's access token, `name` telling one from another.
const jwt = (name: string) =>
  `${base64Url({ alg: "HS256" })}.${base64Url({ data: { uid: 7 }, name })}.sig`

const answer = (status: number, body: string): Answer => ({
  _tag: "answer",
  id: 0,
  status,
  body,
})

// The day's tape in Stockbit's time order: five trades a second, and within
// each second the trade numbers out of order, as Stockbit sends them.
const tapeOrder = (n: number) => {
  const order: Array<number> = []
  for (let first = 1; first <= n; first += 5)
    for (const step of [4, 2, 0, 3, 1])
      if (first + step <= n) order.push(first + step)
  return order
}

// Stockbit's REST running-trade tape for one day (apinrdw/kumora#127): ASC
// pages of `limit` rows after the row whose number is `trade_number`, a
// newest-first `limit=1` call, `is_open_market` until the codes are ready,
// and a bearer it may refuse with 401.
const fakeStockbit = (
  options: {
    readonly n?: number
    // `is_open_market` is true before this time (epoch ms).
    readonly openUntil?: number
    // Rows Stockbit sends with `is_broker_exists: false`.
    readonly noBrokers?: ReadonlySet<number>
    // The token in the tab's cookie at a time.
    readonly cookie?: (now: number) => string
    // Whether the tape refuses this bearer on this call (1-based).
    readonly refuses?: (bearer: string, call: number) => boolean
    // Overrides the tape's answer to a call, by its 1-based index.
    readonly answer?: (
      call: number
    ) => Effect.Effect<Answer | undefined> | undefined
  } = {}
) => {
  const order = tapeOrder(options.n ?? N)
  const urls: Array<string> = []
  const times: Array<number> = []
  const row = (number: number) => ({
    trade_number: String(number),
    code: "BBCA",
    is_broker_exists: !(options.noBrokers?.has(number) ?? false),
    buyer: options.noBrokers?.has(number) ? "" : "YP [D]",
    seller: options.noBrokers?.has(number) ? "" : " PD [F] ",
    buyer_type: "BROKER_TYPE_LOCAL",
    seller_type: "BROKER_TYPE_FOREIGN",
  })
  const page = (url: URL, now: number) => {
    const params = url.searchParams
    const limit = Number(params.get("limit"))
    const open = now < (options.openUntil ?? 0)
    if (params.get("date") !== DAY) return { open, rows: [] }
    if (params.get("sort") === "DESC")
      return { open, rows: order.slice(-limit).reverse() }
    const cursor = params.get("trade_number")
    const from = cursor === null ? 0 : order.indexOf(Number(cursor)) + 1
    return {
      open,
      rows:
        from === 0 && cursor !== null ? [] : order.slice(from, from + limit),
    }
  }
  return {
    urls,
    times,
    // The tape's calls as their query strings.
    params: () => urls.map((url) => new URL(url).searchParams),
    request: (request: TabRequest) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (request._tag === "cookie")
          return Option.some(
            answer(
              200,
              encodeURIComponent(
                JSON.stringify({ token: options.cookie?.(now) ?? jwt("live") })
              )
            )
          )
        if (request._tag !== "fetch") return Option.none<Answer>()
        urls.push(request.url)
        times.push(now)
        const call = urls.length
        const override = options.answer?.(call)
        if (override !== undefined) {
          const answered = yield* override
          if (answered !== undefined) return Option.some(answered)
        }
        const bearer = (request.headers.authorization ?? "").replace(
          "Bearer ",
          ""
        )
        if (options.refuses?.(bearer, call) ?? false)
          return Option.some(answer(401, ""))
        const { open, rows } = page(new URL(request.url), now)
        return Option.some(
          answer(
            200,
            JSON.stringify({
              message: "Successfully loaded running trade data",
              data: { is_open_market: open, running_trade: rows.map(row) },
            })
          )
        )
      }),
  }
}

const YP_PD: TradeCodes = {
  buyer: BrokerCode.make("YP"),
  buyerType: "D",
  seller: BrokerCode.make("PD"),
  sellerType: "F",
}
const CC_PD: TradeCodes = { ...YP_PD, buyer: BrokerCode.make("CC") }

const sameCodes = (a: TradeCodes, b: TradeCodes) =>
  a.buyer === b.buyer &&
  a.buyerType === b.buyerType &&
  a.seller === b.seller &&
  a.sellerType === b.sellerType

// Production's trading-day object, merging batches by its rules
// (apinrdw/kumora#244, "TradingDay's broker codes store") and answering the
// day's status.
const fakeProduction = () => {
  const held = new Map<
    number,
    { codes: TradeCodes; source: "ajaib" | "stockbit" }
  >()
  const differences = new Set<number>()
  const batches: Array<BrokerCodesBatch> = []
  let covered = 0
  let n: number | null = null
  let walkedTo = 0
  let stockbitEnded = false
  const post = (batch: BrokerCodesBatch) =>
    Effect.sync((): PostOutcome => {
      batches.push(batch)
      for (const [text, codes] of batch.rows) {
        const number = Number(text)
        const kept = held.get(number)
        if (batch.feed === "Ajaib") held.set(number, { codes, source: "ajaib" })
        else {
          walkedTo = Math.max(walkedTo, number)
          if (kept === undefined || kept.source === "stockbit")
            held.set(number, { codes, source: "stockbit" })
          else if (sameCodes(kept.codes, codes)) covered++
          else differences.add(number)
        }
      }
      if (batch.end !== undefined) {
        n = Math.max(n ?? 0, Number(batch.end.n))
        if (batch.feed === "Stockbit") stockbitEnded = true
      }
      return "sent"
    })
  const missing = () => {
    const highest = n ?? Math.max(0, ...held.keys())
    const ranges: Array<[TradeNumber, TradeNumber]> = []
    let from: number | undefined
    for (let number = 1; number <= highest + 1; number++) {
      const absent = number <= highest && !held.has(number)
      if (absent && from === undefined) from = number
      if (!absent && from !== undefined) {
        ranges.push([
          TradeNumber.make(String(from)),
          TradeNumber.make(String(number - 1)),
        ])
        from = undefined
      }
    }
    return ranges
  }
  const status = (day: WibDate) =>
    Effect.sync((): BrokerCodesStatus => {
      const sources = { ajaib: 0, stockbit: 0 }
      for (const kept of held.values()) sources[kept.source]++
      const gaps = missing()
      return {
        version: BrokerCodesProtocolVersion,
        day,
        n: n === null ? null : TradeNumber.make(String(n)),
        complete: n !== null && gaps.length === 0,
        missing: gaps,
        sources,
        crossCheck:
          sources.ajaib === 0
            ? { state: "none" }
            : stockbitEnded
              ? { state: "compared", covered, differences: differences.size }
              : {
                  state: "pending",
                  walkedTo: TradeNumber.make(String(walkedTo)),
                },
      }
    })
  return {
    batches,
    held,
    differences,
    post,
    status,
    stockbit: () => batches.filter((batch) => batch.feed === "Stockbit"),
    ends: () =>
      batches.flatMap((batch) =>
        batch.end && batch.feed === "Stockbit" ? [batch.end] : []
      ),
  }
}

// What Ajaib's walk left: trades 1..N but for a stretch it lacked, one it
// lacked inside the busy part, and one whose codes Stockbit disagrees with.
const ajaibServedInPart = Effect.fnUntraced(function* (
  production: ReturnType<typeof fakeProduction>
) {
  const rows: Array<[TradeNumber, TradeCodes]> = []
  for (let number = 1; number <= N; number++) {
    if ((number > 1_000 && number <= 2_000) || number === 500) continue
    rows.push([
      TradeNumber.make(String(number)),
      number === 900 ? CC_PD : YP_PD,
    ])
  }
  for (let at = 0; at < rows.length; at += 5_000)
    yield* production.post({
      version: BrokerCodesProtocolVersion,
      feed: "Ajaib",
      day: DAY,
      rows: rows.slice(at, at + 5_000),
    })
  yield* production.post({
    version: BrokerCodesProtocolVersion,
    feed: "Ajaib",
    day: DAY,
    rows: [],
    end: { n: TradeNumber.make(String(N)) },
  })
})

// Lets a forked walk run until the tape has seen `calls` calls: a long walk
// yields between its calls, which moving the test clock doesn't wait for.
const settle = Effect.fnUntraced(function* (
  tape: ReturnType<typeof fakeStockbit>,
  calls: number
) {
  for (let turn = 0; turn < 100_000 && tape.urls.length < calls; turn++)
    yield* Effect.yieldNow
  yield* Effect.yieldNow
})

const walkWith = (
  tape: ReturnType<typeof fakeStockbit>,
  production = fakeProduction()
) =>
  makeStockbitWalk({
    tab: tape,
    post: production.post,
    status: production.status,
  })

describe("Stockbit's full walk of a day", () => {
  it.effect(
    "cross-checks a day Ajaib served in part: fills its gaps, keeps its copy, records the difference",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        yield* ajaibServedInPart(production)
        const tape = fakeStockbit({ noBrokers: new Set([77]) })
        const walk = yield* walkWith(tape, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        const status = yield* production.status(DAY)
        assert.isTrue(status.complete)
        assert.deepStrictEqual(status.crossCheck, {
          state: "compared",
          covered: N - 1_000 - 1 - 1 - 1,
          differences: 1,
        })
        assert.deepStrictEqual([...production.differences], [900])
        assert.deepStrictEqual(production.held.get(900)?.codes, CC_PD)
        assert.strictEqual(production.held.get(77)?.source, "ajaib")
        assert.strictEqual(production.held.get(1_500)?.source, "stockbit")
        assert.deepStrictEqual(production.ends(), [{ n: String(N) }])
      })
  )

  it.effect(
    "walks forward 100 rows a call on the day's whole market, posting every 10 calls",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const tape = fakeStockbit()
        const walk = yield* walkWith(tape, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.isTrue((yield* production.status(DAY)).complete)
        const params = tape.params()
        // The start call, 24 pages, the empty page, and the end's call.
        assert.lengthOf(params, 1 + 24 + 1 + 1)
        for (const each of params) {
          assert.strictEqual(each.get("date"), DAY)
          assert.isFalse(each.has("symbols"))
          assert.isFalse(each.has("market_board"))
        }
        const pages = params.slice(1, -1)
        for (const each of pages) {
          assert.strictEqual(each.get("sort"), "ASC")
          assert.strictEqual(each.get("limit"), "100")
        }
        assert.isFalse(pages[0]?.has("trade_number"))
        // Each page's cursor is the row Stockbit sent last, not the highest.
        assert.strictEqual(pages[1]?.get("trade_number"), "97")
        assert.deepStrictEqual(
          [params[0], params.at(-1)].map((each) => [
            each?.get("sort"),
            each?.get("limit"),
          ]),
          [
            ["DESC", "1"],
            ["DESC", "1"],
          ]
        )
        const batches = production.stockbit()
        assert.deepStrictEqual(
          batches.map((batch) => batch.rows.length),
          [1_000, 1_000, 345, 0]
        )
        assert.deepStrictEqual(batches.at(-1)?.end, { n: String(N) })
        assert.deepStrictEqual(
          tape.urls.filter(
            (url) =>
              !url.startsWith(
                "https://exodus.stockbit.com/order-trade/running-trade?"
              )
          ),
          []
        )
      })
  )

  it.effect("calls at 3 a second through the Stockbit pacer", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      const tape = fakeStockbit({ n: 1_000 })
      const pacer = yield* makePacer({ feed: "Stockbit", tab: tape })
      yield* Effect.forkChild(pacer.run)
      const walk = yield* makeStockbitWalk({
        tab: pacer.tab("walk"),
        post: production.post,
        status: production.status,
      })
      const fiber = yield* Effect.forkChild(walk.walk(DAY))
      yield* TestClock.adjust("0 millis")
      for (let step = 0; step < 60; step++)
        yield* TestClock.adjust("334 millis")
      assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
      assert.lengthOf(tape.times, 1 + 10 + 1 + 1)
      for (let at = 1; at < tape.times.length; at++)
        assert.isAtLeast((tape.times[at] ?? 0) - (tape.times[at - 1] ?? 0), 334)
    })
  )
})

describe("Stockbit's walk: when it starts and gives up", () => {
  it.effect(
    "polls one newest-first call a minute until Stockbit says the market is closed",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "16:40:00"))
        const production = fakeProduction()
        const tape = fakeStockbit({ openUntil: wib("2026-11-12", "16:58:00") })
        const walk = yield* walkWith(tape, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("17 minutes")
        // 16:40 to 16:57: one newest-first call a minute, nothing else.
        assert.lengthOf(tape.urls, 18)
        for (const each of tape.params()) {
          assert.strictEqual(each.get("sort"), "DESC")
          assert.strictEqual(each.get("limit"), "1")
        }
        assert.deepStrictEqual(production.batches, [])
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.isTrue((yield* production.status(DAY)).complete)
      })
  )

  it.effect("gives up a day Stockbit answers with no rows", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      const tape = fakeStockbit({ n: 0 })
      const walk = yield* walkWith(tape, production)
      assert.deepStrictEqual(yield* walk.walk(DAY), {
        _tag: "unserved",
        reason: "no-rows",
      })
      assert.lengthOf(tape.urls, 1)
      assert.deepStrictEqual(production.batches, [])
    })
  )

  it.effect(
    "stops for a tab, and asks nothing, when no Stockbit tab is relayed",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const walk = yield* makeStockbitWalk({
          tab: { request: () => Effect.succeed(Option.none<Answer>()) },
          post: production.post,
          status: production.status,
        })
        assert.deepStrictEqual(yield* walk.walk(DAY), {
          _tag: "stopped",
          cause: "no-tab",
        })
        assert.deepStrictEqual(production.batches, [])
      })
  )

  it.effect("takes the whole day after Ajaib's walk finds no Ajaib tab", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      const ajaib = yield* makeAjaibWalk({
        tab: { request: () => Effect.succeed(Option.none<Answer>()) },
        post: production.post,
        store: { load: Effect.succeedNone, save: () => Effect.void },
      })
      const stockbit = yield* walkWith(fakeStockbit(), production)
      const idle = yield* Deferred.make<void>()
      const queue = yield* makeRunQueue({
        newestDay: [
          { feed: "Ajaib", walk: ajaib.walk },
          { feed: "Stockbit", walk: stockbit.walk },
        ],
        incompleteDays: { load: Effect.succeed([]), save: () => Effect.void },
        gaps: { feed: "Stockbit", walk: stockbit.gaps },
        history: { walk: () => Effect.succeedNone, catchUp: () => Effect.void },
        catchUp: [],
        paused: Effect.succeed(false),
        report: (progress) =>
          progress.state === "idle"
            ? Deferred.succeed(idle, undefined)
            : Effect.void,
      })
      yield* Effect.forkChild(queue.run)
      yield* queue.trigger
      yield* Deferred.await(idle)
      const status = yield* production.status(DAY)
      assert.isTrue(status.complete)
      assert.deepStrictEqual(status.sources, { ajaib: 0, stockbit: N })
      assert.deepStrictEqual(status.crossCheck, { state: "none" })
    })
  )
})

describe("Stockbit's walk: stopping and carrying on", () => {
  it.effect(
    "a restarted worker carries on from the cross-check's walk position",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        yield* ajaibServedInPart(production)
        // The worker stops during the 25th call.
        const first = fakeStockbit({
          answer: (call) => (call === 25 ? Effect.never : undefined),
        })
        const before = yield* walkWith(first, production)
        const fiber = yield* Effect.forkChild(before.walk(DAY))
        yield* settle(first, 25)
        yield* Fiber.interrupt(fiber)
        const status = yield* production.status(DAY)
        assert.strictEqual(status.crossCheck.state, "pending")
        const walkedTo =
          status.crossCheck.state === "pending"
            ? status.crossCheck.walkedTo
            : ""
        // Two batches of 10 pages went up before the stop.
        assert.strictEqual(walkedTo, "2000")

        const second = fakeStockbit()
        const after = yield* walkWith(second, production)
        assert.deepStrictEqual(yield* after.walk(DAY), { _tag: "walked" })
        const pages = second.params().slice(1, -1)
        assert.strictEqual(pages[0]?.get("trade_number"), walkedTo)
        assert.lengthOf(pages, 5)
        const done = yield* production.status(DAY)
        assert.isTrue(done.complete)
        assert.strictEqual(done.crossCheck.state, "compared")

        // A compared day isn't walked again.
        const third = fakeStockbit()
        const again = yield* walkWith(third, production)
        assert.deepStrictEqual(yield* again.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(third.urls, [])
      })
  )

  it.effect(
    "a day Stockbit walked alone resumes from the highest trade it holds",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const first = fakeStockbit({
          answer: (call) => (call === 15 ? Effect.never : undefined),
        })
        const before = yield* walkWith(first, production)
        const fiber = yield* Effect.forkChild(before.walk(DAY))
        yield* settle(first, 15)
        yield* Fiber.interrupt(fiber)

        const second = fakeStockbit()
        const after = yield* walkWith(second, production)
        assert.deepStrictEqual(yield* after.walk(DAY), { _tag: "walked" })
        assert.strictEqual(second.params()[1]?.get("trade_number"), "1000")
        assert.isTrue((yield* production.status(DAY)).complete)

        // A complete day Stockbit walked alone isn't walked again.
        const third = fakeStockbit()
        const again = yield* walkWith(third, production)
        assert.deepStrictEqual(yield* again.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(third.urls, [])
      })
  )

  it.effect(
    "waits out a 401 in place until the tab's cookie changes, then asks again",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const renewedAt = wib("2026-11-12", "17:44:00")
        const production = fakeProduction()
        const tape = fakeStockbit({
          cookie: (now) => jwt(now >= renewedAt ? "renewed" : "expired"),
          refuses: (bearer, call) => bearer === jwt("expired") && call >= 12,
        })
        const walk = yield* walkWith(tape, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(tape, 12)
        assert.lengthOf(tape.urls, 12)
        yield* TestClock.adjust("13 minutes")
        // 17:43: the cookie hasn't changed, and the walk waits.
        assert.lengthOf(tape.urls, 12)
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        // The refused page is asked again once the cookie changed.
        assert.strictEqual(tape.urls[12], tape.urls[11])
        assert.isTrue((yield* production.status(DAY)).complete)
      })
  )

  it.effect(
    "says Stockbit is signed out while it waits on a 401, and its trades of N",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const renewedAt = wib("2026-11-12", "17:44:00")
        const production = fakeProduction()
        const tape = fakeStockbit({
          cookie: (now) => jwt(now >= renewedAt ? "renewed" : "expired"),
          refuses: (bearer, call) => bearer === jwt("expired") && call >= 12,
        })
        const signedOut: Array<boolean> = []
        const trades: Array<[number, Option.Option<number>]> = []
        const walk = yield* makeStockbitWalk({
          tab: tape,
          post: production.post,
          status: production.status,
          signedOut: (out) =>
            Effect.sync(() => {
              signedOut.push(out)
            }),
          trades: (fetched, of) =>
            Effect.sync(() => {
              trades.push([fetched, of])
            }),
        })
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(tape, 12)
        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(signedOut, [true])
        // N is the newest row the start saw: within its second, not the
        // highest number.
        assert.deepStrictEqual(trades.at(-1), [1_000, Option.some(N - 3)])
        yield* TestClock.adjust("14 minutes")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(signedOut, [true, false])
        assert.deepStrictEqual(trades.at(-1), [N, Option.some(N - 3)])
      })
  )

  it.effect("stops in place at 08:40, posting the pages it holds", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      // The next morning arrives during the 15th call: page 14.
      const tape = fakeStockbit({
        answer: (call) =>
          call === 15
            ? Effect.as(
                TestClock.setTime(wib("2026-11-13", "08:40:00")),
                undefined
              )
            : undefined,
      })
      const walk = yield* walkWith(tape, production)
      assert.deepStrictEqual(yield* walk.walk(DAY), {
        _tag: "stopped",
        cause: "market-hours",
      })
      assert.lengthOf(tape.urls, 15)
      assert.deepStrictEqual(
        production.stockbit().map((batch) => batch.rows.length),
        [1_000, 400]
      )
      assert.deepStrictEqual(production.ends(), [])
    })
  )
})

// The tape's ASC pages: the trade number each one paged after.
const cursors = (tape: ReturnType<typeof fakeStockbit>) =>
  tape
    .params()
    .filter((each) => each.get("sort") === "ASC")
    .map((each) => each.get("trade_number"))

describe("Stockbit's gap walk of an older day", () => {
  it.effect(
    "fetches only the day's missing ranges, each from just below it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-13", "17:30:00"))
        const production = fakeProduction()
        yield* ajaibServedInPart(production)
        const tape = fakeStockbit()
        const walk = yield* walkWith(tape, production)
        assert.deepStrictEqual(yield* walk.gaps(DAY), { _tag: "walked" })
        const status = yield* production.status(DAY)
        assert.isTrue(status.complete)
        // Trade 500 comes first in its second, before 499: a cursor at 499
        // would page past it.
        assert.strictEqual(production.held.get(500)?.source, "stockbit")
        // Each range from a page below it: 1 page for 500, 12 for
        // 1,001..2,000. Nothing past 2,000 but the page that finished it.
        const pages = cursors(tape)
        assert.deepStrictEqual(pages.slice(0, 2), ["399", "900"])
        assert.lengthOf(pages, 1 + 12)
        assert.isFalse(
          production
            .stockbit()
            .some((batch) =>
              batch.rows.some(([number]) => Number(number) > 2_100)
            )
        )
        assert.deepStrictEqual(production.ends(), [])
      })
  )

  it.effect("asks Stockbit nothing for a complete day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-13", "17:30:00"))
      const production = fakeProduction()
      yield* walkWith(fakeStockbit(), production).pipe(
        Effect.flatMap((walk) => walk.walk(DAY))
      )
      const tape = fakeStockbit()
      const walk = yield* walkWith(tape, production)
      assert.deepStrictEqual(yield* walk.gaps(DAY), { _tag: "walked" })
      assert.deepStrictEqual(tape.urls, [])
    })
  )

  it.effect(
    "walks a day whose end isn't known on to the end, and posts it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        // Stockbit's walk of the day stopped during its 15th call, at 08:40.
        const first = fakeStockbit({
          answer: (call) =>
            call === 15
              ? Effect.as(
                  TestClock.setTime(wib("2026-11-13", "08:40:00")),
                  undefined
                )
              : undefined,
        })
        yield* walkWith(first, production).pipe(
          Effect.flatMap((walk) => walk.walk(DAY))
        )
        production.held.delete(250)
        yield* TestClock.setTime(wib("2026-11-13", "17:30:00"))
        const tape = fakeStockbit()
        const walk = yield* walkWith(tape, production)
        assert.deepStrictEqual(yield* walk.gaps(DAY), { _tag: "walked" })
        assert.isTrue((yield* production.status(DAY)).complete)
        assert.deepStrictEqual(production.ends(), [{ n: String(N) }])
        assert.deepStrictEqual(cursors(tape).slice(0, 2), ["149", "1400"])
      })
  )

  it.effect(
    "keeps a day whose gaps Stockbit sends without codes for a later run",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-13", "17:30:00"))
        const production = fakeProduction()
        yield* ajaibServedInPart(production)
        const tape = fakeStockbit({ noBrokers: new Set([1_500]) })
        const walk = yield* walkWith(tape, production)
        assert.deepStrictEqual(yield* walk.gaps(DAY), {
          _tag: "unserved",
          reason: "incomplete",
        })
        assert.deepStrictEqual(
          (yield* production.status(DAY)).missing.map((range) =>
            range.map(Number)
          ),
          [[1_500, 1_500]]
        )
        // Trade 1,500 was seen: the walk didn't run on to the day's end.
        assert.lengthOf(cursors(tape), 1 + 12)
      })
  )

  it.effect("gives up a day Stockbit answers with no rows", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-13", "17:30:00"))
      const production = fakeProduction()
      yield* ajaibServedInPart(production)
      const tape = fakeStockbit({ n: 0 })
      const walk = yield* walkWith(tape, production)
      assert.deepStrictEqual(yield* walk.gaps(DAY), {
        _tag: "unserved",
        reason: "no-rows",
      })
      assert.lengthOf(tape.urls, 1)
    })
  )
})

describe("the History walk over Stockbit's walk", () => {
  // Production holding DAY as the walk leaves it, 2026-11-13 complete, and
  // nothing of any other day.
  const historyProduction = () => {
    const production = fakeProduction()
    const asked: Array<string> = []
    const status = (day: WibDate) =>
      Effect.suspend((): Effect.Effect<BrokerCodesStatus> => {
        asked.push(day)
        if (day === DAY) return production.status(day)
        return Effect.succeed({
          version: BrokerCodesProtocolVersion,
          day,
          n: day === "2026-11-13" ? TradeNumber.make("10") : null,
          complete: day === "2026-11-13",
          missing: [],
          sources: { ajaib: 0, stockbit: day === "2026-11-13" ? 10 : 0 },
          crossCheck: { state: "none" },
        })
      })
    return { ...production, asked, status }
  }

  const memoryPosition = () => {
    let kept = Option.none<HistoryPosition>()
    return {
      position: () => kept,
      lose: () => {
        kept = Option.none()
      },
      store: {
        load: Effect.sync(() => kept),
        save: (next: HistoryPosition) =>
          Effect.sync(() => {
            kept = Option.some(next)
          }),
      },
    }
  }

  const historyOver = Effect.fnUntraced(function* (
    tape: ReturnType<typeof fakeStockbit>,
    production: ReturnType<typeof historyProduction>,
    position: ReturnType<typeof memoryPosition>
  ) {
    const walk = yield* makeStockbitWalk({
      tab: tape,
      post: production.post,
      status: production.status,
    })
    return yield* makeHistoryWalk({
      walk: { feed: "Stockbit", walk: walk.gaps },
      store: position.store,
      catchUp: { feed: "Stockbit", walk: walk.gaps },
      catchUpStore: { load: Effect.succeedNone, save: () => Effect.void },
      report: () => Effect.void,
    })
  })

  // The 15 weekdays from 2026-11-11 back.
  const ended = Option.some({
    oldest: WibDate.make("2026-10-22"),
    empty: 15,
    ended: true,
  })

  it.effect(
    "skips a complete day from its status, walks a traded day whole, and posts nothing for an untraded one",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-16", "17:30:00"))
        const production = historyProduction()
        const tape = fakeStockbit()
        const position = memoryPosition()
        const history = yield* historyOver(tape, production, position)
        assert.deepStrictEqual(
          yield* history.walk(WibDate.make("2026-11-16")),
          Option.none()
        )
        const dates = new Set(tape.params().map((each) => each.get("date")))
        assert.isFalse(dates.has("2026-11-13"))
        assert.isTrue(dates.has("2026-11-11"))
        const status = yield* production.status(DAY)
        assert.isTrue(status.complete)
        assert.deepStrictEqual(status.crossCheck, { state: "none" })
        assert.isTrue(production.batches.every((batch) => batch.day === DAY))
        assert.deepStrictEqual(production.ends(), [{ n: String(N) }])
        assert.deepStrictEqual(position.position(), ended)
      })
  )

  it.effect(
    "rebuilds a lost position from each day's status, asking Stockbit only of the empty days",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-16", "17:30:00"))
        const production = historyProduction()
        const position = memoryPosition()
        const first = yield* historyOver(fakeStockbit(), production, position)
        yield* first.walk(WibDate.make("2026-11-16"))
        const posted = production.batches.length
        position.lose()
        production.asked.length = 0
        const tape = fakeStockbit()
        const again = yield* historyOver(tape, production, position)
        yield* again.walk(WibDate.make("2026-11-16"))
        assert.deepStrictEqual(position.position(), ended)
        // One status GET a day: 2026-11-13, DAY, and the 15 empty days.
        assert.lengthOf(production.asked, 2 + 15)
        // One newest-first call for each empty day, and nothing posted.
        assert.lengthOf(tape.urls, 15)
        assert.isFalse(tape.params().some((each) => each.get("date") === DAY))
        assert.strictEqual(production.batches.length, posted)
      })
  )
})

describe("Stockbit's walk and the extra target", () => {
  it.effect("tees each of the walk's batches to the extra target", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      const staging = fakeProduction()
      const extra = yield* makeExtraTarget({
        target: Effect.succeed(
          Option.some({
            origin: DashboardOrigin.make("https://staging.example"),
            token: "staging-token",
          })
        ),
        production: Effect.succeedNone,
        send: ({ body }) =>
          Effect.as(
            Effect.flatMap(
              Effect.orDie(decodeBrokerCodesBatch(body)),
              (batch) => staging.post(batch)
            ),
            200
          ),
        get: () => Effect.succeedNone,
        report: () => Effect.void,
      })
      yield* Effect.forkChild(extra.run)
      const walk = yield* makeStockbitWalk({
        tab: fakeStockbit(),
        post: extra.tee(production.post),
        status: production.status,
      })
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      const sent = production.stockbit().length
      for (
        let turn = 0;
        turn < 1_000 && staging.stockbit().length < sent;
        turn++
      )
        yield* Effect.yieldNow
      assert.isAbove(sent, 1)
      assert.deepStrictEqual(staging.stockbit(), production.stockbit())
      assert.isTrue((yield* staging.status(DAY)).complete)
      assert.deepStrictEqual(staging.ends(), [{ n: String(N) }])
    })
  )

  it.effect(
    "the extra target's catch-up fills its own missing ranges, and only them",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        yield* walkWith(fakeStockbit(), production).pipe(
          Effect.flatMap((walk) => walk.walk(DAY))
        )
        // The extra target kept Ajaib's batches, and missed Stockbit's.
        const staging = fakeProduction()
        yield* ajaibServedInPart(staging)
        const statusOf = (target: ReturnType<typeof fakeProduction>) =>
          Effect.map(target.status(DAY), (status) =>
            Option.some(JSON.stringify(status))
          )
        const extra = yield* makeExtraTarget({
          target: Effect.succeed(
            Option.some({
              origin: DashboardOrigin.make("https://staging.example"),
              token: "staging-token",
            })
          ),
          production: Effect.succeed(
            Option.some({
              origin: DashboardOrigin.make("https://production.example"),
              token: "production-token",
            })
          ),
          send: ({ body }) =>
            Effect.as(
              Effect.flatMap(
                Effect.orDie(decodeBrokerCodesBatch(body)),
                (batch) => staging.post(batch)
              ),
              200
            ),
          get: ({ url }) =>
            statusOf(url.startsWith("https://staging") ? staging : production),
          report: () => Effect.void,
        })
        const tape = fakeStockbit()
        const catchUp = yield* extra.catchUp("Stockbit", ({ post, status }) =>
          stockbitCatchUp({ tab: tape, post, status })
        )
        assert.deepStrictEqual(yield* catchUp.walk(DAY), { _tag: "walked" })
        assert.isTrue((yield* staging.status(DAY)).complete)
        assert.deepStrictEqual(
          staging
            .stockbit()
            .flatMap((batch) => batch.rows.map(([number]) => Number(number)))
            .filter(
              (number) => number !== 500 && (number < 1_001 || number > 2_000)
            ),
          []
        )
        assert.deepStrictEqual(cursors(tape).slice(0, 2), ["399", "900"])
      })
  )
})
