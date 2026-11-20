import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  MISSING_RANGES,
  StockCode,
  OrderNumber,
  TradeNumber,
  WibDate,
  decodeBrokerCodesBatch,
  encodeBrokerCodesStatus,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type TradeCodes,
  type TradeFields,
} from "@workspace/relay"
import { Clock, DateTime, Deferred, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeAjaibWalk } from "../../src/worker/broker-codes/ajaib-walk.ts"
import { makeExtraTarget } from "../../src/worker/broker-codes/extra-target.ts"
import {
  makeHistoryWalk,
  type HistoryPosition,
} from "../../src/worker/broker-codes/history.ts"
import type { PostOutcome } from "../../src/worker/broker-codes/poster.ts"
import { makeProductionTarget } from "../../src/worker/broker-codes/production-target.ts"
import { makeTargetHold } from "../../src/worker/broker-codes/target-hold.ts"
import {
  makeRunQueue,
  type IncompleteDaysStore,
} from "../../src/worker/broker-codes/run-queue.ts"
import {
  makeStockbitWalk,
  stockbitCatchUp,
} from "../../src/worker/broker-codes/stockbit-walk.ts"
import type { Answer, TabRequest } from "../../src/worker/broker.ts"
import { makePacer } from "../../src/worker/pacer.ts"
import { DashboardOrigin } from "../../src/worker/settings.ts"
import hope from "./fixtures/stockbit-hope-2026-11-20.json"

const DAY = WibDate.make("2026-11-12")

// An incomplete-days list that keeps nothing.
const noIncompleteDays: IncompleteDaysStore = {
  load: Effect.succeed([]),
  save: () => Effect.void,
  lastNewest: Effect.succeedNone,
  saveLastNewest: () => Effect.void,
}
const wib = (date: string, time: string) => Date.parse(`${date}T${time}+07:00`)
const N = 2_345

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("=", "")
// The Stockbit page's access token, `name` telling one from another.
const jwt = (name: string) =>
  `${base64Url({ alg: "HS256" })}.${base64Url({ data: { uid: 7 }, name })}.sig`

// The WIB `HH:MM:SS` the fake tape gives each trade: a second apart from
// 09:00:00, through 14:59:59.
const clockOf = (number: number) => {
  const second = 9 * 3_600 + (number % 21_600)
  return [second / 3_600, (second / 60) % 60, second % 60]
    .map((part) => String(Math.floor(part)).padStart(2, "0"))
    .join(":")
}

// The fields the fake tape gives each trade, its own for each number: every
// 50th on the negotiated board, an odd lot, and a price past a thousand,
// which Stockbit sends comma-grouped; a buy, a sell, or neither in turn.
const fieldsOf = (number: number): TradeFields => ({
  time: DateTime.makeUnsafe(`${DAY}T${clockOf(number)}+07:00`),
  code: StockCode.make(number % 2 === 0 ? "BBCA" : "TLKM"),
  price: 8_000 + (number % 40) * 25,
  lots: number % 50 === 0 ? 0.5 : 1_000 + (number % 7),
  board: number % 50 === 0 ? "NG" : "RG",
  side: (["buy", "sell", "none"] as const)[number % 3]!,
})
const FIELDS = fieldsOf(1)

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
    // Rows Stockbit sends with codes but zero lots.
    readonly badLots?: ReadonlySet<number>
    // Trade numbers the tape skips: Stockbit never sends them.
    readonly absent?: ReadonlySet<number>
    // The token in the tab's `credentialStorage` cookie at a time; "" for
    // the cookie a Google sign-in leaves, with the user and no token.
    readonly cookie?: (now: number) => string
    // The tab's `sb_social_access_token` cookie at a time, "" without one.
    readonly social?: (now: number) => string
    // Whether the tape refuses this bearer on this call (1-based).
    readonly refuses?: (bearer: string, call: number) => boolean
    // Overrides the tape's answer to a call, by its 1-based index.
    readonly answer?: (
      call: number
    ) => Effect.Effect<Answer | undefined> | undefined
  } = {}
) => {
  const order = tapeOrder(options.n ?? N).filter(
    (number) => !(options.absent?.has(number) ?? false)
  )
  const urls: Array<string> = []
  const times: Array<number> = []
  const row = (number: number) => ({
    trade_number: String(number),
    time: clockOf(number),
    ...(fieldsOf(number).side === "none"
      ? {}
      : { action: fieldsOf(number).side }),
    code: fieldsOf(number).code,
    price: fieldsOf(number).price.toLocaleString("en-US"),
    lot: options.badLots?.has(number)
      ? "n/a"
      : fieldsOf(number).lots.toLocaleString("en-US"),
    market_board: fieldsOf(number).board,
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
  // A cookie's raw value at a time, "" for one the tab lacks.
  const cookie = (name: string, now: number) => {
    if (name === "sb_social_access_token") return options.social?.(now) ?? ""
    if (name !== "credentialStorage") return ""
    const token = options.cookie?.(now) ?? jwt("live")
    return encodeURIComponent(
      JSON.stringify(
        token === "" ? { state: { user: { id: 7 } }, version: 0 } : { token }
      )
    )
  }
  return {
    urls,
    times,
    attached: Effect.succeed(true),
    // The tape's calls as their query strings.
    params: () => urls.map((url) => new URL(url).searchParams),
    request: (request: TabRequest) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (request._tag === "cookie")
          return Option.some(answer(200, cookie(request.name, now)))
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
// day's status: a trade is missing until it has codes and fields.
const fakeProduction = () => {
  const held = new Map<
    number,
    { codes: TradeCodes; source: "ajaib" | "stockbit" }
  >()
  // The trades a row with fields came for.
  const fielded = new Set<number>()
  const takeFields = (batch: BrokerCodesBatch) => {
    for (const [text, , fields] of batch.rows)
      if (fields !== undefined && fields !== null) fielded.add(Number(text))
  }
  const differences = new Set<number>()
  const batches: Array<BrokerCodesBatch> = []
  let covered = 0
  let n: number | null = null
  let walkedTo = 0
  let stockbitEnded = false
  const post = (batch: BrokerCodesBatch) =>
    Effect.sync((): PostOutcome => {
      batches.push(batch)
      takeFields(batch)
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
      const absent =
        number <= highest && !(held.has(number) && fielded.has(number))
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
  // The `after` of each status asked.
  const afters: Array<number> = []
  // As the dashboard lists them: at most MISSING_RANGES past `after`.
  const status = (day: WibDate, after = TradeNumber.make("0")) =>
    Effect.sync((): BrokerCodesStatus => {
      afters.push(Number(after))
      const sources = { ajaib: 0, stockbit: 0 }
      for (const kept of held.values()) sources[kept.source]++
      const gaps = missing()
      return {
        version: BrokerCodesProtocolVersion,
        day,
        n: n === null ? null : TradeNumber.make(String(n)),
        complete: n !== null && gaps.length === 0,
        missing: gaps
          .filter(([, to]) => Number(to) > Number(after))
          .slice(0, MISSING_RANGES)
          .map(([from, to]): [TradeNumber, TradeNumber] => [
            Number(from) > Number(after)
              ? from
              : TradeNumber.make(String(Number(after) + 1)),
            to,
          ]),
        missingCount: gaps.reduce(
          (sum, [from, to]) => sum + Number(to) - Number(from) + 1,
          0
        ),
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
        orderNumbers: { ajaib: 0, stockbit: 0, differences: 0 },
      }
    })
  return {
    batches,
    held,
    differences,
    afters,
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
  const rows: Array<[TradeNumber, TradeCodes, TradeFields]> = []
  for (let number = 1; number <= N; number++) {
    if ((number > 1_000 && number <= 2_000) || number === 500) continue
    rows.push([
      TradeNumber.make(String(number)),
      number === 900 ? CC_PD : YP_PD,
      FIELDS,
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
  tape: Pick<ReturnType<typeof fakeStockbit>, "attached" | "request">,
  production = fakeProduction()
) =>
  makeStockbitWalk({
    tab: tape,
    post: production.post,
    status: production.status,
  })

// The fake's status as Production's target reads it, over a GET of the
// status path the service worker hands the walk.
const throughProductionTarget = (
  production: ReturnType<typeof fakeProduction>
) =>
  Effect.flatMap(makeTargetHold(Effect.void), (hold) =>
    makeProductionTarget({
      target: Effect.succeed(
        Option.some({
          origin: DashboardOrigin.make("https://production.example"),
          token: "ingest-token",
        })
      ),
      send: () => Effect.succeed(200),
      get: ({ url }) =>
        Effect.gen(function* () {
          const after = new URL(url).searchParams.get("after") ?? "0"
          const status = yield* production.status(DAY, TradeNumber.make(after))
          return { status: 200, body: yield* encodeBrokerCodesStatus(status) }
        }).pipe(Effect.orDie),
      hold,
    })
  )

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
    "posts each trade's own fields, its time and side, with its codes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const tape = fakeStockbit()
        const walk = yield* walkWith(tape, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        // As many calls as the codes-only walk made (apinrdw/kumora#440).
        assert.lengthOf(tape.urls, 27)
        const fields = new Map(
          production
            .stockbit()
            .flatMap((batch) =>
              batch.rows.flatMap(([number, , each]) =>
                each === undefined ? [] : [[Number(number), each] as const]
              )
            )
        )
        assert.strictEqual(fields.size, N)
        for (let number = 1; number <= N; number++)
          assert.deepStrictEqual(fields.get(number), fieldsOf(number))
      })
  )

  it.effect(
    "posts the codes alone of a trade whose row has codes but no valid fields",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const walk = yield* walkWith(
          fakeStockbit({ badLots: new Set([7, 1_234]) }),
          production
        )
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.strictEqual(production.held.size, N)
        const unfielded = production
          .stockbit()
          .flatMap((batch) =>
            batch.rows.flatMap(([number, , each]) =>
              each === undefined ? [Number(number)] : []
            )
          )
        assert.sameMembers(unfielded, [7, 1_234])
        assert.lengthOf(unfielded, 2)
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
      const pacer = yield* makePacer({
        feed: "Stockbit",
        tab: { ...tape, awaitAnswer: tape.request },
      })
      yield* Effect.forkChild(pacer.run)
      const walk = yield* makeStockbitWalk({
        tab: { ...pacer.tab("walk"), attached: tape.attached },
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

// Spec apinrdw/kumora#627, "Slice 1": HOPE's first 150 rows of 2026-11-20
// as Stockbit sent them after the close (sb-HOPE-2026-11-20 on
// research/order-number-routes), each with its buy and sell order number.
describe("Stockbit's walk and order numbers", () => {
  const HOPE_DAY = WibDate.make("2026-11-20")
  type HopeRow = (typeof hope)[number]

  // Stockbit's tape of `rows`, in their captured order, closed.
  const hopeTape = (rows: ReadonlyArray<HopeRow>) => ({
    attached: Effect.succeed(true),
    request: (request: TabRequest) =>
      Effect.sync(() => {
        if (request._tag === "cookie")
          return Option.some(
            answer(
              200,
              request.name === "credentialStorage"
                ? encodeURIComponent(JSON.stringify({ token: jwt("live") }))
                : ""
            )
          )
        if (request._tag !== "fetch") return Option.none<Answer>()
        const params = new URL(request.url).searchParams
        const cursor = params.get("trade_number")
        const from =
          cursor === null
            ? 0
            : rows.findIndex((row) => row.trade_number === cursor) + 1
        const page =
          params.get("sort") === "DESC"
            ? rows.slice(-1)
            : rows.slice(from, from + Number(params.get("limit")))
        return Option.some(
          answer(
            200,
            JSON.stringify({
              data: { is_open_market: false, running_trade: page },
            })
          )
        )
      }),
  })

  // Each posted row's order numbers by trade number, none for a row
  // without.
  const postedOrders = (production: ReturnType<typeof fakeProduction>) =>
    new Map(
      production
        .stockbit()
        .flatMap((batch) =>
          batch.rows.map(([number, , , orders]) => [number, orders] as const)
        )
    )

  it.effect("posts each trade's buy and sell order number", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib(HOPE_DAY, "20:20:00"))
      const production = fakeProduction()
      const walk = yield* walkWith(hopeTape(hope), production)
      assert.deepStrictEqual(yield* walk.walk(HOPE_DAY), { _tag: "walked" })
      const posted = postedOrders(production)
      assert.strictEqual(posted.size, hope.length)
      for (const row of hope)
        assert.deepStrictEqual(posted.get(TradeNumber.make(row.trade_number)), [
          OrderNumber.make(Number(row.buy_order_number)),
          OrderNumber.make(Number(row.sell_order_number)),
        ])
      // HOPE's trade 8799: a buy whose group order is the buy order.
      assert.deepStrictEqual(posted.get(TradeNumber.make("8799")), [
        OrderNumber.make(276_574),
        OrderNumber.make(53_352),
      ])
    })
  )

  it.effect(
    "walked whole, posts every trade's order numbers again though the day is walked",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib(HOPE_DAY, "20:20:00"))
        const production = fakeProduction()
        const walk = yield* walkWith(hopeTape(hope), production)
        yield* walk.walk(HOPE_DAY)
        const again = fakeProduction()
        const whole = yield* makeStockbitWalk({
          tab: hopeTape(hope),
          post: again.post,
          status: production.status,
        })
        assert.deepStrictEqual(yield* whole.whole(HOPE_DAY), {
          _tag: "walked",
        })
        assert.deepStrictEqual(postedOrders(again), postedOrders(production))
        assert.strictEqual(postedOrders(again).size, hope.length)
      })
  )

  it.effect(
    "posts none for a row with an order number of 0, and its codes and fields still",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib(HOPE_DAY, "20:20:00"))
        const production = fakeProduction()
        const zeroed = hope.map((row) =>
          row.trade_number === "8800" ? { ...row, sell_order_number: "0" } : row
        )
        const walk = yield* walkWith(hopeTape(zeroed), production)
        assert.deepStrictEqual(yield* walk.walk(HOPE_DAY), { _tag: "walked" })
        const row = production
          .stockbit()
          .flatMap((batch) => batch.rows)
          .find(([number]) => number === "8800")
        assert.isDefined(row)
        assert.lengthOf(row, 3)
        assert.isDefined(row[2])
        assert.isUndefined(
          postedOrders(production).get(TradeNumber.make("8800"))
        )
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
          tab: {
            attached: Effect.succeed(false),
            request: () => Effect.succeed(Option.none<Answer>()),
          },
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

  it.effect(
    "takes the whole day once Ajaib's walk finds no Ajaib tab by 00:00 WIB",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "23:58:00"))
        const production = fakeProduction()
        const ajaib = yield* makeAjaibWalk({
          tab: {
            attached: Effect.succeed(false),
            reload: Effect.void,
            request: () => Effect.succeed(Option.none<Answer>()),
          },
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
          incompleteDays: noIncompleteDays,
          status: production.status,
          gaps: { feed: "Stockbit", walk: stockbit.gaps },
          history: {
            walk: () => Effect.succeedNone,
            catchUp: () => Effect.void,
          },
          catchUp: [],
          gapsCatchUp: { feed: "Stockbit", walk: stockbit.gaps },
          paused: Effect.succeed(false),
          report: (progress) =>
            progress.state === "idle"
              ? Deferred.succeed(idle, undefined)
              : Effect.void,
        })
        yield* Effect.forkChild(queue.run)
        yield* queue.trigger
        yield* TestClock.adjust("3 minutes")
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
    "a day Stockbit walked alone resumes a page below the highest trade it holds",
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
        assert.strictEqual(second.params()[1]?.get("trade_number"), "900")
        assert.isTrue((yield* production.status(DAY)).complete)

        // A complete day Stockbit walked alone isn't walked again.
        const third = fakeStockbit()
        const again = yield* walkWith(third, production)
        assert.deepStrictEqual(yield* again.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(third.urls, [])
      })
  )

  it.effect(
    "a day Stockbit walked alone, a row of it posted without fields, resumes a page below where it walked",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const first = fakeStockbit({
          badLots: new Set([5]),
          answer: (call) => (call === 15 ? Effect.never : undefined),
        })
        const before = yield* walkWith(first, production)
        const fiber = yield* Effect.forkChild(before.walk(DAY))
        yield* settle(first, 15)
        yield* Fiber.interrupt(fiber)

        const second = fakeStockbit({ badLots: new Set([5]) })
        const after = yield* walkWith(second, production)
        yield* after.walk(DAY)
        assert.strictEqual(second.params()[1]?.get("trade_number"), "900")
        assert.deepStrictEqual(
          (yield* production.status(DAY)).missing.map((range) =>
            range.map(Number)
          ),
          [[5, 5]]
        )
      })
  )

  it.effect(
    "a day whose last row before the cut was posted without fields walks every trade Stockbit sent after the resume",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        // The dashboard's status for trades 1..10 held and trade 15 posted
        // codes-only, n unknown: no range above the highest held trade.
        const status: BrokerCodesStatus = {
          version: BrokerCodesProtocolVersion,
          day: DAY,
          n: null,
          complete: false,
          missing: [],
          missingCount: 0,
          sources: { ajaib: 0, stockbit: 11 },
          orderNumbers: { ajaib: 0, stockbit: 0, differences: 0 },
          crossCheck: { state: "none" },
        }
        const posted = new Set<number>()
        const walk = yield* makeStockbitWalk({
          tab: fakeStockbit({ n: 30, badLots: new Set([15]) }),
          post: (batch) =>
            Effect.sync((): PostOutcome => {
              for (const [number] of batch.rows) posted.add(Number(number))
              return "sent"
            }),
          status: () => Effect.succeed(status),
        })
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(
          [11, 12, 13, 14].filter((number) => !posted.has(number)),
          []
        )
      })
  )

  it.effect(
    "asks a failed call again 10 s later while the tab is still attached",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const tape = fakeStockbit()
        let fetches = 0
        const tab = {
          attached: Effect.succeed(true),
          request: (request: TabRequest) =>
            request._tag === "fetch" && ++fetches === 5
              ? Effect.succeed(Option.none<Answer>())
              : tape.request(request),
        }
        const walk = yield* makeStockbitWalk({
          tab,
          post: production.post,
          status: production.status,
        })
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(tape, 4)
        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.isTrue((yield* production.status(DAY)).complete)
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
    "waits out a 401 on a Google sign-in's token until sb_social_access_token changes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const renewedAt = wib("2026-11-12", "17:44:00")
        const production = fakeProduction()
        const tape = fakeStockbit({
          cookie: () => "",
          social: (now) => jwt(now >= renewedAt ? "renewed" : "expired"),
          refuses: (bearer, call) => bearer === jwt("expired") && call >= 12,
        })
        const walk = yield* walkWith(tape, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(tape, 12)
        yield* TestClock.adjust("13 minutes")
        assert.lengthOf(tape.urls, 12)
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
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

  it.effect(
    "waits signed out on cookies with no token until a Google sign-in's sb_social_access_token appears, then walks with it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const signedInAt = wib("2026-11-12", "17:44:00")
        const production = fakeProduction()
        const tape = fakeStockbit({
          cookie: () => "",
          social: (now) => (now >= signedInAt ? jwt("google") : ""),
          refuses: (bearer) => bearer !== jwt("google"),
        })
        const signedOut: Array<boolean> = []
        const walk = yield* makeStockbitWalk({
          tab: tape,
          post: production.post,
          status: production.status,
          signedOut: (out) =>
            Effect.sync(() => {
              signedOut.push(out)
            }),
        })
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("13 minutes")
        // 17:43: neither cookie holds a token, and the walk waits.
        assert.deepStrictEqual(signedOut, [true])
        assert.lengthOf(tape.urls, 0)
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(signedOut, [true, false])
        assert.isTrue((yield* production.status(DAY)).complete)
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
        cause: "streaming-hours",
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
        // On from a page below the trades with codes: a trade missing them,
        // as 250 is, reads as one a codes-only row could be.
        assert.deepStrictEqual(cursors(tape).slice(0, 2), ["149", "1299"])
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

  it.effect(
    "stops a range a page past it when Stockbit lacks a trade in it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-13", "17:30:00"))
        const production = fakeProduction()
        yield* ajaibServedInPart(production)
        const tape = fakeStockbit({ absent: new Set([1_500]) })
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
        // 1 page for 500, 12 for 1,001..2,000, and the one page past 2,000
        // that shows the range is done: not on to the day's end.
        assert.lengthOf(cursors(tape), 1 + 12 + 1)
      })
  )

  // Slow on purpose: a capped list takes MISSING_RANGES ranges, so the walk
  // decodes about 1,000 Stockbit pages. It took 1.7 s on CI and three times
  // that on a slow run (apinrdw/kumora#332), so its timeout leaves 10x.
  it.effect(
    "asks the status again after a capped list, past ranges Stockbit can't fill",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-13", "17:30:00"))
        const production = fakeProduction()
        // Ajaib lacked every even trade to 2,200: 1,100 ranges, past one
        // status's list. Stockbit sends the first 1,000 without codes.
        const evens = (to: number) =>
          Array.from({ length: to / 2 }, (_, at) => 2 * at + 2)
        const lacked = new Set(evens(2_200))
        const rows: Array<[TradeNumber, TradeCodes, TradeFields]> = []
        for (let number = 1; number <= N; number++)
          if (!lacked.has(number))
            rows.push([TradeNumber.make(String(number)), YP_PD, FIELDS])
        yield* production.post({
          version: BrokerCodesProtocolVersion,
          feed: "Ajaib",
          day: DAY,
          rows,
          end: { n: TradeNumber.make(String(N)) },
        })
        const tape = fakeStockbit({ noBrokers: new Set(evens(2_000)) })
        const target = yield* throughProductionTarget(production)
        const walk = yield* makeStockbitWalk({
          tab: tape,
          post: production.post,
          status: target.status,
        })
        assert.deepStrictEqual(yield* walk.gaps(DAY), {
          _tag: "unserved",
          reason: "incomplete",
        })
        // From trade 1, after the 1,000th range's 2,000, whose list of 100
        // was the last, and from trade 1 to read the day.
        assert.deepStrictEqual(production.afters, [0, 2_000, 0])
        const status = yield* production.status(DAY)
        assert.strictEqual(status.missingCount, 1_000)
        assert.deepStrictEqual(
          status.missing.at(-1)?.map(Number),
          [2_000, 2_000]
        )
        assert.strictEqual(production.held.get(2_200)?.source, "stockbit")
      }),
    { timeout: 20_000 }
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
          missingCount: 0,
          sources: { ajaib: 0, stockbit: day === "2026-11-13" ? 10 : 0 },
          orderNumbers: { ajaib: 0, stockbit: 0, differences: 0 },
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
      incompleteDays: noIncompleteDays,
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
    "walks again a day walked codes-only, whose trades lack their fields, from a fresh position",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-16", "17:30:00"))
        const production = historyProduction()
        const rows: Array<[TradeNumber, TradeCodes]> = []
        for (let number = 1; number <= N; number++)
          rows.push([TradeNumber.make(String(number)), YP_PD])
        yield* production.post({
          version: BrokerCodesProtocolVersion,
          feed: "Stockbit",
          day: DAY,
          rows,
          end: { n: TradeNumber.make(String(N)) },
        })
        assert.strictEqual((yield* production.status(DAY)).missingCount, N)
        const tape = fakeStockbit()
        const history = yield* historyOver(tape, production, memoryPosition())
        yield* history.walk(WibDate.make("2026-11-16"))
        assert.isTrue(tape.params().some((each) => each.get("date") === DAY))
        assert.isTrue((yield* production.status(DAY)).complete)
        const walked = production
          .stockbit()
          .flatMap((batch) => batch.rows)
          .filter(([, , fields]) => fields !== undefined)
        assert.lengthOf(walked, N)
        assert.deepStrictEqual(
          walked.find(([number]) => number === "7")?.[2],
          fieldsOf(7)
        )
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

// The extra target's hold, on Staging's settings.
const stagingHold = Effect.tap(makeTargetHold(Effect.void), (hold) =>
  hold.restart(
    Option.some({
      origin: DashboardOrigin.make("https://staging.example"),
      token: "staging-token",
    })
  )
)

describe("Stockbit's walk and the extra target", () => {
  it.effect("tees each of the walk's batches to the extra target", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      const staging = fakeProduction()
      const extra = yield* makeExtraTarget({
        production: Effect.succeedNone,
        send: ({ body }) =>
          Effect.as(
            Effect.flatMap(
              Effect.orDie(decodeBrokerCodesBatch(body)),
              (batch) => staging.post(batch)
            ),
            200
          ),
        get: () => Effect.succeed({ status: 0, body: "" }),
        hold: yield* stagingHold,
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
          Effect.map(target.status(DAY), (status) => ({
            status: 200,
            body: JSON.stringify(status),
          }))
        const extra = yield* makeExtraTarget({
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
          hold: yield* stagingHold,
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
