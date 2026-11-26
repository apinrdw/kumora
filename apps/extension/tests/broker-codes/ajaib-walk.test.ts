import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  StockCode,
  TradeNumber,
  WibDate,
  type BrokerCodesBatch,
  type TradeFields,
} from "@workspace/relay"
import { Clock, DateTime, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

import {
  makeAjaibWalk,
  type AjaibWalkPosition,
  type AjaibWalkStore,
} from "../../src/worker/broker-codes/ajaib-walk.ts"
import type { TapeTrade } from "../../src/worker/broker-codes/done-details-walk.ts"
import type { PostOutcome } from "../../src/worker/broker-codes/poster.ts"
import type { WalkPhase } from "../../src/worker/broker-codes/run-queue.ts"
import type { Answer, TabRequest } from "../../src/worker/broker.ts"

const DAY = WibDate.make("2026-11-12")
const wib = (date: string, time: string) => Date.parse(`${date}T${time}+07:00`)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

// A quiet Thursday's tape: the opening match's 100 trades sharing one ms,
// 100 quiet trades through the day, then 100 in the 16:00 auction's first
// second. Trade numbers rise with time. Each pass takes it in one page.
const dayTrades = () => {
  const times: Array<number> = []
  for (let at = 0; at < 100; at++) times.push(wib("2026-11-12", "08:58:00"))
  for (let at = 0; at < 100; at++)
    times.push(wib("2026-11-12", "09:00:00") + at * 4 * MINUTE)
  for (let at = 0; at < 100; at++)
    times.push(wib("2026-11-12", "16:00:00") + at * 10)
  return times
}
const N = 300
const TIMES = dayTrades()
// A busy day's tape, which the first pass takes in two pages of 50,000.
const BUSY_N = 60_000
const busyRows = () =>
  Array.from({ length: BUSY_N }, (_, at) => ({
    number: at + 1,
    date: "2026-11-12",
    timestamp: wib("2026-11-12", "09:00:00") + at * 100,
  }))
// A walk of the busy day decodes 120,000 rows, slow on purpose, so its
// tests set their own timeout.
const BUSY_TIMEOUT = 30_000

interface TapeRow {
  readonly number: number
  readonly date: string
  readonly timestamp: number
}

const OK = (body: unknown): Answer => ({
  _tag: "answer",
  id: 0,
  status: 200,
  body: JSON.stringify(body),
})
const STATUS = (status: number): Answer => ({
  _tag: "answer",
  id: 0,
  status,
  body: "",
})

const STATUS_PATH = "v1/stock/data/trading-day/time/"

// A JWT naming `sub` that expires at `exp` (epoch seconds), by default a day
// after the tests' evening.
const jwt = (sub: string, exp = wib("2026-11-13", "17:30:00") / 1000) =>
  `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub, exp })).replaceAll("=", "")}.c2lnbmF0dXJl`

// The fields but the time the fake tape gives each trade, its own for each
// number: every 50th on the negotiated board, an odd lot; a buy, a sell, or
// neither in turn.
const fieldsOf = (number: number): Omit<TradeFields, "time"> => ({
  code: StockCode.make(number % 2 === 0 ? "BBCA" : "TLKM"),
  price: 8_000 + (number % 40) * 25,
  lots: number % 50 === 0 ? 0.5 : 1 + (number % 7),
  board: number % 50 === 0 ? "NG" : "RG",
  side: (["buy", "sell", "none"] as const)[number % 3]!,
})
const SIDES = { buy: "BUY", sell: "SELL", none: "" } as const

const paramOf = (path: string, name: string) =>
  Number(new URL(path, "https://ht2.ajaib.co.id/api/").searchParams.get(name))
const sizeOf = (path: string) => paramOf(path, "page_size")
const pageOf = (path: string) => paramOf(path, "page")
const lastTimestampOf = (path: string) => paramOf(path, "last_timestamp")
// The walk's calls after the head call, whose 40 rows give the day's N.
const isWalkPage = (path: string) => path !== STATUS_PATH && sizeOf(path) > 40

// Ajaib's REST tape as probed on 2026-11-26 (apinrdw/kumora#707): the rows
// before `last_timestamp`, newest first, paged by offset; page k starts at
// (k - 1) × (P + 1) and holds P rows, so each page boundary skips one row.
const fakeAjaib = (
  options: {
    readonly rows?: ReadonlyArray<TapeRow>
    // `trading-day/time/`'s status at a time (epoch ms).
    readonly market?: (now: number) => string
    // Before this time the tape's rows carry no codes yet.
    readonly codesFrom?: number
    // The page's latest bearer token at a time.
    readonly token?: (now: number) => string
    // The `trade_access_token` cookie's raw value at a time; "" without one.
    readonly cookie?: (now: number) => string
    // Whether a page's first row comes without a trade number.
    readonly malformed?: (path: string) => boolean
    // Whether the tape says no page follows a page that it would page past.
    readonly lastPage?: (path: string) => boolean
    // Trades the tape sends with codes but zero lots.
    readonly badLots?: ReadonlySet<number>
    // Trades the tape sends with codes but no stock code.
    readonly noStockCode?: ReadonlySet<number>
    // Overrides the tape's answer to a call, by its 1-based index.
    readonly answer?: (
      request: TabRequest,
      call: number
    ) => Effect.Effect<Answer | undefined> | undefined
  } = {}
) => {
  const rows = [
    ...(options.rows ??
      dayTrades().map((timestamp, at) => ({
        number: at + 1,
        date: "2026-11-12",
        timestamp,
      }))),
  ].sort((a, b) => b.timestamp - a.timestamp || b.number - a.number)
  const paths: Array<string> = []
  const page = (path: string, now: number) => {
    const valid = now >= (options.codesFrom ?? 0)
    const at = lastTimestampOf(path)
    const number = pageOf(path)
    const size = sizeOf(path)
    const before = rows.filter((row) => row.timestamp < at)
    const offset = (number - 1) * (size + 1)
    const malformed = options.malformed?.(path) ?? false
    return OK({
      page: number,
      page_size: size,
      has_next:
        offset + size < before.length && !(options.lastPage?.(path) ?? false),
      results: before.slice(offset, offset + size).map((row, index) => ({
        stock_code: options.noStockCode?.has(row.number)
          ? null
          : fieldsOf(row.number).code,
        price: fieldsOf(row.number).price,
        lot: options.badLots?.has(row.number)
          ? null
          : fieldsOf(row.number).lots,
        ...(fieldsOf(row.number).board === "NG" ? { market_type: "NG" } : {}),
        side: SIDES[fieldsOf(row.number).side],
        trade_num:
          malformed && index === 0
            ? "not a trade number"
            : `${row.date.replaceAll("-", "")}${String(row.number).padStart(10, "0")}`,
        date: row.date,
        timestamp: row.timestamp,
        buyer: valid ? "YP" : "",
        buyer_type: valid ? "D" : "",
        seller: "PD",
        seller_type: "F",
      })),
    })
  }
  const pageFetch = (path: string, now: number) =>
    path === STATUS_PATH
      ? OK({ result: { status: options.market?.(now) ?? "CLOSED" } })
      : page(path, now)
  let reloads = 0
  return {
    paths,
    attached: Effect.succeed(true),
    reload: Effect.sync(() => {
      reloads++
    }),
    reloads: () => reloads,
    tapeCalls: () => paths.filter((path) => path !== STATUS_PATH),
    walkPages: () => paths.filter(isWalkPage),
    request: (request: TabRequest) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (request._tag === "page-token")
          return Option.some<Answer>({
            ...STATUS(200),
            body: options.token?.(now) ?? "token",
          })
        if (request._tag === "cookie")
          return Option.some<Answer>({
            ...STATUS(200),
            body: options.cookie?.(now) ?? "",
          })
        if (request._tag !== "page-fetch") return Option.none<Answer>()
        paths.push(request.path)
        const override = options.answer?.(request, paths.length)
        return override === undefined
          ? Option.some(pageFetch(request.path, now))
          : Option.fromNullishOr(yield* override)
      }),
  }
}

const memoryStore = () => {
  let held = Option.none<AjaibWalkPosition>()
  const store: AjaibWalkStore = {
    load: Effect.sync(() => held),
    save: (position) =>
      Effect.sync(() => {
        held = Option.some(position)
      }),
  }
  return { store, held: () => held }
}

// Production, as the batches it was posted.
const fakeProduction = () => {
  const batches: Array<BrokerCodesBatch> = []
  return {
    batches,
    post: (batch: BrokerCodesBatch) =>
      Effect.sync((): PostOutcome => {
        batches.push(batch)
        return "sent"
      }),
    // Each posted trade's fields.
    fields: () =>
      new Map(
        batches.flatMap((batch) =>
          batch.rows.flatMap(([number, , fields]) =>
            fields === undefined ? [] : [[Number(number), fields] as const]
          )
        )
      ),
    // The trade numbers posted with codes.
    held: () =>
      new Set(
        batches.flatMap((batch) => batch.rows.map(([number]) => Number(number)))
      ),
    ends: () => batches.flatMap((batch) => (batch.end ? [batch.end] : [])),
  }
}

const missingOf = (held: ReadonlySet<number>, n = N) => {
  const missing: Array<number> = []
  for (let number = 1; number <= n; number++)
    if (!held.has(number)) missing.push(number)
  return missing
}

// Lets a forked walk run until the tab has seen `calls` page fetches: a long
// walk yields between its calls, which moving the test clock doesn't wait for.
const settle = Effect.fnUntraced(function* (
  tab: ReturnType<typeof fakeAjaib>,
  calls: number
) {
  for (let turn = 0; turn < 100_000 && tab.paths.length < calls; turn++)
    yield* Effect.yieldNow
  yield* Effect.yieldNow
})

const walkWith = (
  tab: ReturnType<typeof fakeAjaib>,
  production = fakeProduction(),
  store = memoryStore().store
) => makeAjaibWalk({ tab, post: production.post, store })

describe("Ajaib's walk of the day", () => {
  it.effect(
    "walks the whole day at 50,000 then 49,999 rows a page under one last_timestamp, posting every trade 1..N, then end",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "17:30:00")
        yield* TestClock.setTime(start)
        const production = fakeProduction()
        let firstPass = new Set<number>()
        const trades: Array<[number, Option.Option<number>]> = []
        const tab = fakeAjaib({
          rows: busyRows(),
          answer: (request) => {
            if (
              request._tag === "page-fetch" &&
              sizeOf(request.path) === 49_999 &&
              firstPass.size === 0
            )
              firstPass = production.held()
            return undefined
          },
        })
        const walk = yield* makeAjaibWalk({
          tab,
          post: production.post,
          store: memoryStore().store,
          trades: (fetched, of) =>
            Effect.sync(() => {
              trades.push([fetched, of])
            }),
        })
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(
          tab.walkPages().map((path) => [sizeOf(path), pageOf(path)]),
          [
            [50_000, 1],
            [50_000, 2],
            [49_999, 1],
            [49_999, 2],
          ]
        )
        for (const path of tab.walkPages())
          assert.strictEqual(lastTimestampOf(path), start + HOUR)
        // The first pass skipped the 50,001st newest trade at its page
        // boundary; the second pass filled it.
        assert.deepStrictEqual(missingOf(firstPass, BUSY_N), [10_000])
        assert.deepStrictEqual(missingOf(production.held(), BUSY_N), [])
        assert.deepStrictEqual(trades.at(-1), [BUSY_N - 1, Option.some(BUSY_N)])
        assert.deepStrictEqual(production.ends(), [{ n: String(BUSY_N) }])
        assert.deepStrictEqual(production.batches.at(-1)?.end, {
          n: String(BUSY_N),
        })
        for (const batch of production.batches) {
          assert.isAtMost(batch.rows.length, 5_000)
          assert.strictEqual(batch.feed, "Ajaib")
          assert.strictEqual(batch.day, DAY)
        }
      }),
    BUSY_TIMEOUT
  )

  it.effect(
    "ends a pass at a full page the tape says no page follows, and pages on past a full page that holds a malformed row",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        // The first pass's only page leads with a row without a trade
        // number, and says it is the last; the second pass's pages don't.
        const firstPage = (path: string) =>
          sizeOf(path) === 50_000 && pageOf(path) === 1
        const tab = fakeAjaib({
          rows: busyRows(),
          malformed: firstPage,
          lastPage: firstPage,
        })
        const walk = yield* walkWith(tab, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(
          tab.walkPages().map((path) => [sizeOf(path), pageOf(path)]),
          [
            [50_000, 1],
            [49_999, 1],
            [49_999, 2],
          ]
        )
        assert.deepStrictEqual(missingOf(production.held(), BUSY_N), [])
      }),
    BUSY_TIMEOUT
  )

  it.effect(
    "stops a pass whose tape never stops paging at 100 pages",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        // Every page of a pass answers in full and says more follow: rows
        // without a trade number, so the day's own trades never page out.
        const endless = (size: number) =>
          `{"has_next":true,"results":[${Array.from({ length: size }, () => "{}").join(",")}]}`
        const bodies = new Map(
          [50_000, 49_999].map((size) => [size, endless(size)] as const)
        )
        const tab = fakeAjaib({
          answer: (request) => {
            if (request._tag !== "page-fetch") return undefined
            const body = bodies.get(sizeOf(request.path))
            return body === undefined
              ? undefined
              : Effect.succeed({ ...STATUS(200), body })
          },
        })
        const walk = yield* walkWith(tab, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        const pages = tab.walkPages()
        assert.lengthOf(pages, 200)
        assert.strictEqual(pageOf(pages[99] ?? ""), 100)
        assert.strictEqual(sizeOf(pages[100] ?? ""), 49_999)
        assert.deepStrictEqual(production.ends(), [{ n: String(N) }])
      }),
    BUSY_TIMEOUT
  )

  it.effect("never posts a row of another date", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      const yesterday = Array.from({ length: 50 }, (_, at) => ({
        number: 900_000 + at,
        date: "2026-11-11",
        timestamp: wib("2026-11-11", "15:00:00") + at * 1_000,
      }))
      const today = dayTrades().map((timestamp, at) => ({
        number: at + 1,
        date: "2026-11-12",
        timestamp,
      }))
      const walk = yield* walkWith(
        fakeAjaib({ rows: [...today, ...yesterday] }),
        production
      )
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      assert.deepStrictEqual(missingOf(production.held()), [])
      assert.strictEqual(production.held().size, N)
    })
  )

  it.effect(
    "posts each trade's own fields, its time and side, with its codes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const walk = yield* walkWith(fakeAjaib(), production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        const fields = production.fields()
        assert.strictEqual(fields.size, N)
        for (let number = 1; number <= N; number++)
          assert.deepStrictEqual(fields.get(number), {
            ...fieldsOf(number),
            time: DateTime.makeUnsafe(TIMES[number - 1]!),
          })
      })
  )

  it.effect(
    "posts the codes alone of a trade whose row has codes but no valid fields",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const walk = yield* walkWith(
          fakeAjaib({ badLots: new Set([7, 250]) }),
          production
        )
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
        const fields = production.fields()
        assert.strictEqual(fields.size, N - 2)
        assert.isFalse(fields.has(7))
        assert.isFalse(fields.has(250))
      })
  )

  it.effect(
    "keeps each page's trades with a stock code for the Done Details walk before posting them, unkeyed without valid fields",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const kept = new Map<string, TapeTrade>()
        // How many trades were kept when each batch went up.
        const keptAtPost: Array<number> = []
        const walk = yield* makeAjaibWalk({
          tab: fakeAjaib({
            badLots: new Set([7]),
            noStockCode: new Set([9]),
          }),
          post: (batch) =>
            Effect.andThen(
              Effect.sync(() => keptAtPost.push(kept.size)),
              production.post(batch)
            ),
          store: memoryStore().store,
          keep: (day, trades) =>
            Effect.sync(() => {
              assert.strictEqual(day, DAY)
              for (const trade of trades) kept.set(trade.number, trade)
            }),
        })
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.strictEqual(kept.size, N - 1)
        assert.strictEqual(keptAtPost[0], N - 1)
        assert.deepStrictEqual(kept.get("7"), {
          _tag: "Unkeyed",
          number: TradeNumber.make("7"),
          code: fieldsOf(7).code,
        })
        assert.isFalse(kept.has("9"))
        // Trade 1: the 08:58 opening match.
        assert.deepStrictEqual(kept.get("1"), {
          _tag: "Kept",
          number: TradeNumber.make("1"),
          code: StockCode.make("TLKM"),
          second: "08:58:00",
          board: "RG",
          price: 8_025,
          lots: 2,
          side: "sell",
          codes: {
            buyer: BrokerCode.make("YP"),
            buyerType: "D",
            seller: BrokerCode.make("PD"),
            sellerType: "F",
          },
        })
        // Trade 300: 16:00:00.990, in its second.
        assert.include(kept.get("300"), { second: "16:00:00" })
      })
  )
})

describe("Ajaib's walk: when it starts", () => {
  it.effect(
    "polls once a minute until Ajaib says CLOSED and the newest page carries codes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "16:36:00"))
        const closesAt = wib("2026-11-12", "16:58:00")
        const production = fakeProduction()
        const tab = fakeAjaib({
          market: (now) => (now >= closesAt ? "CLOSED" : "OPEN"),
          codesFrom: wib("2026-11-12", "17:01:00"),
        })
        const walk = yield* walkWith(tab, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("21 minutes")
        // 16:36 to 16:57: one status call a minute, nothing else.
        assert.lengthOf(tab.paths, 22)
        assert.deepStrictEqual(tab.tapeCalls(), [])
        yield* TestClock.adjust("1 minute")
        // 16:58: closed, but the newest page carries no codes yet.
        assert.lengthOf(tab.tapeCalls(), 1)
        assert.strictEqual(sizeOf(tab.tapeCalls()[0] ?? ""), 40)
        yield* TestClock.adjust("2 minutes")
        assert.lengthOf(tab.tapeCalls(), 3)
        assert.deepStrictEqual(production.batches, [])
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
      })
  )

  it.effect(
    "polls a tape whose newest row is another day's until 00:00 WIB, then leaves the day to Stockbit",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const tab = fakeAjaib({
          rows: [
            {
              number: 7,
              date: "2026-11-11",
              timestamp: wib("2026-11-11", "16:10:00"),
            },
          ],
        })
        const walk = yield* walkWith(tab, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("3 minutes")
        assert.isUndefined(fiber.pollUnsafe())
        assert.lengthOf(tab.tapeCalls(), 4)
        yield* TestClock.setTime(wib("2026-11-13", "00:00:00"))
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), {
          _tag: "unserved",
          reason: "window-passed",
        })
        assert.deepStrictEqual(production.batches, [])
      })
  )

  // Seen on Saturday 2026-11-14: Ajaib's tape answered `count: 0` for
  // Friday. Past 00:00 WIB the walk no longer asks.
  it.effect("leaves a day to Stockbit at once past 00:00 WIB that night", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-14", "10:25:00"))
      const production = fakeProduction()
      const tab = fakeAjaib({ rows: [] })
      const walk = yield* walkWith(tab, production)
      assert.deepStrictEqual(yield* walk.walk(WibDate.make("2026-11-13")), {
        _tag: "unserved",
        reason: "window-passed",
      })
      assert.lengthOf(tab.paths, 0)
      assert.deepStrictEqual(production.batches, [])
    })
  )

  it.effect("polls an empty tape until it holds the day's rows", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      let empty = true
      const full = fakeAjaib()
      const tab = fakeAjaib({
        rows: [],
        answer: (request) =>
          empty
            ? undefined
            : Effect.flatMap(full.request(request), (answer) =>
                Effect.succeed(Option.getOrUndefined(answer))
              ),
      })
      const walk = yield* walkWith(tab, production)
      const fiber = yield* Effect.forkChild(walk.walk(DAY))
      yield* TestClock.adjust("0 millis")
      yield* TestClock.adjust("5 minutes")
      assert.isUndefined(fiber.pollUnsafe())
      empty = false
      yield* TestClock.adjust("1 minute")
      assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
      assert.deepStrictEqual(missingOf(production.held()), [])
    })
  )

  it.effect(
    "on a 401 with no token Ajaib hasn't refused, reloads the Ajaib tab each minute and sends nothing",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const tab = fakeAjaib({
          answer: (request) =>
            request._tag === "page-fetch" && request.path !== STATUS_PATH
              ? Effect.succeed(STATUS(401))
              : undefined,
        })
        const walk = yield* walkWith(tab)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("2 minutes")
        assert.isUndefined(fiber.pollUnsafe())
        assert.lengthOf(tab.tapeCalls(), 1)
        assert.strictEqual(tab.reloads(), 2)
        yield* Fiber.interrupt(fiber)
      })
  )

  it.effect(
    "never sends an expired page token, whose 401 the browser hides as a CORS error, and walks once the cookie holds a fresh one",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "17:30:00")
        yield* TestClock.setTime(start)
        const production = fakeProduction()
        const stale = jwt("stale", start / 1000 - 3600)
        const fresh = jwt("fresh")
        const bearers: Array<string | undefined> = []
        const tab = fakeAjaib({
          token: () => stale,
          cookie: (now) => (now >= start + 30_000 ? fresh : ""),
          answer: (request) => {
            if (request._tag !== "page-fetch") return undefined
            bearers.push(request.bearer)
            return request.bearer === fresh
              ? undefined
              : Effect.succeed(undefined)
          },
        })
        const walk = yield* walkWith(tab, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
        assert.isTrue(bearers.every((bearer) => bearer === fresh))
      })
  )

  it.effect(
    "reports waiting for the close, a token wait with its reloads, then fetching, each since when",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "16:40:00")
        yield* TestClock.setTime(start)
        const phases: Array<WalkPhase> = []
        let calls = 0
        const tab = fakeAjaib({
          market: (now) => (now >= start + 2 * MINUTE ? "CLOSED" : "OPEN"),
          answer: (request) => {
            if (request._tag !== "page-fetch") return undefined
            calls++
            return calls === 1 ? Effect.succeed(STATUS(401)) : undefined
          },
          token: (now) => (now >= start + 90_000 ? "new" : "old"),
        })
        const walk = yield* makeAjaibWalk({
          tab,
          post: fakeProduction().post,
          store: memoryStore().store,
          phase: (phase) =>
            Effect.sync(() => {
              phases.push(phase)
            }),
        })
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("5 minutes")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        const refused = {
          step: "awaiting-close",
          since: start,
          stall: { kind: "refused-token", failures: 1, tokenChanged: false },
        } as const
        assert.deepStrictEqual(phases, [
          { step: "awaiting-close", since: start },
          refused,
          { step: "awaiting-token", since: start, reloads: 0 },
          { step: "awaiting-token", since: start, reloads: 1 },
          // Back from the token wait, its call still retrying, then answered.
          refused,
          { step: "awaiting-close", since: start },
          // The close is seen on the minute's poll after the token wait.
          { step: "fetching", since: start + 150_000 },
        ])
      })
  )

  it.effect(
    "on a 401 waits for the page's new token, then sends the page's headers again",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "17:30:00")
        yield* TestClock.setTime(start)
        const production = fakeProduction()
        // The page signs a call afresh 30 s in.
        const pageToken = (now: number) =>
          now >= start + 30_000 ? "new" : "old"
        let calls = 0
        const tab = fakeAjaib({
          token: pageToken,
          answer: (request) => {
            if (request._tag !== "page-fetch") return undefined
            calls++
            return calls === 1 ? Effect.succeed(STATUS(401)) : undefined
          },
        })
        const walk = yield* walkWith(tab, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("40 seconds")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
        assert.strictEqual(tab.reloads(), 0)
      })
  )

  it.effect("waits for an Ajaib tab to be relayed, then walks the day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      let open = false
      const fake = fakeAjaib()
      const walk = yield* makeAjaibWalk({
        tab: {
          attached: Effect.sync(() => open),
          reload: Effect.void,
          request: (request) =>
            Effect.suspend(() =>
              open ? fake.request(request) : Effect.succeed(Option.none())
            ),
        },
        post: production.post,
        store: memoryStore().store,
      })
      const fiber = yield* Effect.forkChild(walk.walk(DAY))
      yield* TestClock.adjust("30 minutes")
      assert.isUndefined(fiber.pollUnsafe())
      assert.deepStrictEqual(production.batches, [])
      open = true
      yield* TestClock.adjust("1 minute")
      assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
      assert.deepStrictEqual(missingOf(production.held()), [])
    })
  )

  it.effect(
    "with no Ajaib tab until 00:00 WIB, leaves the day to Stockbit",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const walk = yield* makeAjaibWalk({
          tab: {
            attached: Effect.succeed(false),
            reload: Effect.void,
            request: () => Effect.succeed(Option.none<Answer>()),
          },
          post: production.post,
          store: memoryStore().store,
        })
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("6 hours")
        assert.isUndefined(fiber.pollUnsafe())
        yield* TestClock.setTime(wib("2026-11-13", "00:00:00"))
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), {
          _tag: "unserved",
          reason: "window-passed",
        })
        assert.deepStrictEqual(production.batches, [])
      })
  )
})

// The small day's calls: 1 the status, 2 the head, 3 the first pass's page,
// 4 the second pass's.
const FIRST_PAGE_CALL = 3

describe("Ajaib's walk: stopping and carrying on", () => {
  it.effect(
    "a restarted worker resumes at its kept page with the kept last_timestamp",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "17:30:00")
        yield* TestClock.setTime(start)
        const production = fakeProduction()
        const kept = memoryStore()
        // The worker stops during the first pass's second page.
        let stopped = false
        const first = fakeAjaib({
          rows: busyRows(),
          answer: (request) => {
            if (
              request._tag !== "page-fetch" ||
              sizeOf(request.path) !== 50_000 ||
              pageOf(request.path) !== 2
            )
              return undefined
            stopped = true
            return Effect.never
          },
        })
        const before = yield* walkWith(first, production, kept.store)
        const fiber = yield* Effect.forkChild(before.walk(DAY))
        for (let turn = 0; turn < 100_000 && !stopped; turn++)
          yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        assert.deepStrictEqual(
          kept.held(),
          Option.some({
            day: DAY,
            pass: "first" as const,
            page: 2,
            lastTimestamp: start + HOUR,
          })
        )

        yield* TestClock.adjust("10 minutes")
        const second = fakeAjaib({ rows: busyRows() })
        const after = yield* walkWith(second, production, kept.store)
        assert.deepStrictEqual(yield* after.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(
          second.walkPages().map((path) => [sizeOf(path), pageOf(path)]),
          [
            [50_000, 2],
            [49_999, 1],
            [49_999, 2],
          ]
        )
        for (const path of second.walkPages())
          assert.strictEqual(lastTimestampOf(path), start + HOUR)
        assert.deepStrictEqual(missingOf(production.held(), BUSY_N), [])

        // A walked day isn't walked again.
        const third = fakeAjaib()
        const again = yield* walkWith(third, production, kept.store)
        assert.deepStrictEqual(yield* again.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(third.paths, [])
      }),
    BUSY_TIMEOUT
  )

  it.effect(
    "a worker restarted in the second pass doesn't walk the first again",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "17:30:00")
        yield* TestClock.setTime(start)
        const kept = memoryStore()
        yield* kept.store.save({
          day: DAY,
          pass: "second",
          page: 1,
          lastTimestamp: start - 10 * MINUTE,
        })
        const production = fakeProduction()
        const tab = fakeAjaib()
        const walk = yield* walkWith(tab, production, kept.store)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(
          tab.walkPages().map((path) => [sizeOf(path), lastTimestampOf(path)]),
          [[49_999, start - 10 * MINUTE]]
        )
        assert.deepStrictEqual(production.ends(), [{ n: String(N) }])
      })
  )

  it.effect(
    "waits out a 401 until the page shows a new token, then asks again",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const renewedAt = wib("2026-11-12", "17:44:00")
        const production = fakeProduction()
        const tab = fakeAjaib({
          token: (now) => (now >= renewedAt ? "renewed" : "expired"),
          answer: (_, call) =>
            call === FIRST_PAGE_CALL ? Effect.succeed(STATUS(401)) : undefined,
        })
        const walk = yield* walkWith(tab, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(tab, FIRST_PAGE_CALL)
        assert.lengthOf(tab.paths, FIRST_PAGE_CALL)
        yield* TestClock.adjust("13 minutes")
        // 17:43: the page hasn't renewed its token, and the walk waits.
        assert.lengthOf(tab.paths, FIRST_PAGE_CALL)
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        // The refused page is asked again once the token changed.
        assert.strictEqual(
          tab.paths[FIRST_PAGE_CALL],
          tab.paths[FIRST_PAGE_CALL - 1]
        )
        assert.deepStrictEqual(missingOf(production.held()), [])
      })
  )

  it.effect(
    "asks again once a 401 lands after the page already renewed the token the call was sent with",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        let token = "expired"
        const production = fakeProduction()
        const tab = fakeAjaib({
          token: () => token,
          // The page renews its token while the first pass's call is in
          // flight, whose answer is still the old token's 401.
          answer: (_, call) =>
            call === FIRST_PAGE_CALL
              ? Effect.sync(() => {
                  token = "renewed"
                  return STATUS(401)
                })
              : undefined,
        })
        const walk = yield* walkWith(tab, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(tab, FIRST_PAGE_CALL)
        yield* TestClock.adjust("10 seconds")
        yield* settle(tab, FIRST_PAGE_CALL + 1)
        assert.isAbove(tab.paths.length, FIRST_PAGE_CALL)
        assert.strictEqual(
          tab.paths[FIRST_PAGE_CALL],
          tab.paths[FIRST_PAGE_CALL - 1]
        )
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
      })
  )

  it.effect(
    "waits in place when its Ajaib tab goes mid-walk, then carries on",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        let gone = false
        // The tab closes during the first pass's call, which gets no answer.
        const fake = fakeAjaib({
          answer: (_, call) =>
            call === FIRST_PAGE_CALL
              ? Effect.sync(() => {
                  gone = true
                  return undefined
                })
              : undefined,
        })
        const walk = yield* makeAjaibWalk({
          tab: { ...fake, attached: Effect.sync(() => !gone) },
          post: production.post,
          store: memoryStore().store,
        })
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(fake, FIRST_PAGE_CALL)
        yield* TestClock.adjust("20 minutes")
        assert.isUndefined(fiber.pollUnsafe())
        assert.lengthOf(fake.paths, FIRST_PAGE_CALL)
        gone = false
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.strictEqual(
          fake.paths[FIRST_PAGE_CALL],
          fake.paths[FIRST_PAGE_CALL - 1]
        )
        assert.deepStrictEqual(missingOf(production.held()), [])
      })
  )

  it.effect("stops in place at 08:40, when Streaming hours start", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      // The next morning arrives during the first pass's call.
      const tab = fakeAjaib({
        answer: (_, call) =>
          call === FIRST_PAGE_CALL
            ? Effect.as(
                TestClock.setTime(wib("2026-11-13", "08:40:00")),
                undefined
              )
            : undefined,
      })
      const walk = yield* walkWith(tab, production)
      const fiber = yield* Effect.forkChild(walk.walk(DAY))
      yield* settle(tab, FIRST_PAGE_CALL)
      // The tab gave no answer, so the walk asks again in 10 s, and finds
      // Streaming hours started.
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        _tag: "stopped",
        cause: "streaming-hours",
      })
      assert.lengthOf(tab.paths, FIRST_PAGE_CALL)
      assert.deepStrictEqual(production.ends(), [])
    })
  )
})

// The page-fetches' bearers, in order, of a fake tab whose calls answer as
// `answer` says, by the bearer and the call's 1-based index.
const signedTab = (
  options: Omit<NonNullable<Parameters<typeof fakeAjaib>[0]>, "answer"> & {
    readonly answer?: (
      bearer: string | undefined,
      call: number
    ) => Effect.Effect<Answer | undefined> | undefined
  }
) => {
  const bearers: Array<string | undefined> = []
  const tab = fakeAjaib({
    ...options,
    answer: (request, call) => {
      if (request._tag !== "page-fetch") return undefined
      bearers.push(request.bearer)
      return options.answer?.(request.bearer, call)
    },
  })
  return { tab, bearers }
}

// A walk of `tab` that keeps every phase it reports.
const phasedWalk = Effect.fnUntraced(function* (
  tab: ReturnType<typeof fakeAjaib>
) {
  const phases: Array<WalkPhase> = []
  const walk = yield* makeAjaibWalk({
    tab,
    post: fakeProduction().post,
    store: memoryStore().store,
    phase: (phase) =>
      Effect.sync(() => {
        phases.push(phase)
      }),
  })
  return { walk, phases }
})

describe("Ajaib's walk: its walk token", () => {
  it.effect(
    "signs each call with the cookie's token read at that call, a new one on the very next call",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const first = jwt("first")
        const second = jwt("second")
        let calls = 0
        const { tab, bearers } = signedTab({
          token: () => jwt("page"),
          cookie: () => (calls >= 3 ? second : first),
          answer: () => {
            calls++
            return undefined
          },
        })
        const walk = yield* walkWith(tab)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(bearers.slice(0, 3), [first, first, first])
        assert.isTrue(bearers.slice(3).every((bearer) => bearer === second))
      })
  )

  it.effect("with no token in the cookie, signs with the page's own", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const page = jwt("page")
      const { tab, bearers } = signedTab({ token: () => page })
      const walk = yield* walkWith(tab)
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      assert.isTrue(bearers.every((bearer) => bearer === page))
    })
  )

  it.effect(
    "never sends again a token Ajaib answered with a 401, and walks the day with the next",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const cookie = jwt("cookie")
        const page = jwt("page")
        const { tab, bearers } = signedTab({
          // URL-encoded and wrapped in quotes, as Ajaib sets it.
          cookie: () => encodeURIComponent(`"${cookie}"`),
          token: () => page,
          answer: (bearer) =>
            bearer === cookie ? Effect.succeed(STATUS(401)) : undefined,
        })
        const walk = yield* walkWith(tab, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
        assert.strictEqual(bearers[0], cookie)
        assert.isTrue(bearers.slice(1).every((bearer) => bearer === page))
        assert.strictEqual(tab.reloads(), 0)
      })
  )

  it.effect(
    "refuses a token whose calls got no answer twice in a row, and never sends it again",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const cookie = jwt("cookie")
        const page = jwt("page")
        const { tab, bearers } = signedTab({
          cookie: () => cookie,
          token: () => page,
          answer: (bearer) =>
            bearer === cookie ? Effect.succeed(undefined) : undefined,
        })
        const walk = yield* walkWith(tab, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        assert.deepStrictEqual(bearers, [cookie])
        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
        assert.deepStrictEqual(bearers.slice(0, 2), [cookie, cookie])
        assert.isTrue(bearers.slice(2).every((bearer) => bearer === page))
      })
  )

  it.effect(
    "retries one unanswered tape page in 10 s with the same token, and keeps it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const cookie = jwt("cookie")
        const { tab, bearers } = signedTab({
          cookie: () => cookie,
          token: () => jwt("page"),
          // The first pass's first page of 50,000 rows gets no answer once.
          answer: (_, call) =>
            call === FIRST_PAGE_CALL ? Effect.succeed(undefined) : undefined,
        })
        const walk = yield* walkWith(tab)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(tab, FIRST_PAGE_CALL)
        assert.lengthOf(tab.paths, FIRST_PAGE_CALL)
        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        const page = tab.paths[FIRST_PAGE_CALL - 1] ?? ""
        assert.strictEqual(sizeOf(page), 50_000)
        assert.strictEqual(pageOf(page), 1)
        assert.strictEqual(tab.paths[FIRST_PAGE_CALL], page)
        assert.isTrue(bearers.every((bearer) => bearer === cookie))
      })
  )

  it.effect(
    "retries a call the tab didn't answer in time with the same token, and never refuses it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const cookie = jwt("cookie")
        const { tab, bearers } = signedTab({
          cookie: () => cookie,
          token: () => jwt("page"),
          answer: (_, call) =>
            call <= 3
              ? Effect.as(Effect.sleep("15 seconds"), undefined)
              : undefined,
        })
        const walk = yield* walkWith(tab)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("2 minutes")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(tab.paths.slice(0, 4), [
          STATUS_PATH,
          STATUS_PATH,
          STATUS_PATH,
          STATUS_PATH,
        ])
        assert.isTrue(bearers.every((bearer) => bearer === cookie))
      })
  )

  it.effect(
    "reports a refused token's stall cause while it retries, and clears it once a call answers",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "17:30:00")
        yield* TestClock.setTime(start)
        const cookie = jwt("cookie")
        const { tab } = signedTab({
          cookie: () => cookie,
          token: () => jwt("page"),
          answer: (bearer) =>
            bearer === cookie ? Effect.succeed(STATUS(401)) : undefined,
        })
        const { walk, phases } = yield* phasedWalk(tab)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(phases.slice(0, 3), [
          { step: "awaiting-close", since: start },
          {
            step: "awaiting-close",
            since: start,
            stall: { kind: "refused-token", failures: 1, tokenChanged: false },
          },
          { step: "awaiting-close", since: start },
        ])
      })
  )

  it.effect(
    "reports unanswered calls' stall cause with their count, then the next token's answer clears it",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "17:30:00")
        yield* TestClock.setTime(start)
        const cookie = jwt("cookie")
        const { tab } = signedTab({
          cookie: () => cookie,
          token: () => jwt("page"),
          answer: (bearer) =>
            bearer === cookie ? Effect.succeed(undefined) : undefined,
        })
        const { walk, phases } = yield* phasedWalk(tab)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(phases.slice(0, 4), [
          { step: "awaiting-close", since: start },
          {
            step: "awaiting-close",
            since: start,
            stall: { kind: "no-answer", failures: 1, tokenChanged: false },
          },
          {
            step: "awaiting-close",
            since: start,
            stall: { kind: "no-answer", failures: 2, tokenChanged: false },
          },
          { step: "awaiting-close", since: start },
        ])
      })
  )

  it.effect(
    "reports timed-out calls' stall cause, and whether the walk token changed since the first",
    () =>
      Effect.gen(function* () {
        const start = wib("2026-11-12", "17:30:00")
        yield* TestClock.setTime(start)
        const first = jwt("first")
        const second = jwt("second")
        const { tab } = signedTab({
          // Ajaib rotates the cookie's token 20 s in.
          cookie: (now) => (now >= start + 20_000 ? second : first),
          token: () => jwt("page"),
          answer: (_, call) =>
            call <= 2
              ? Effect.as(Effect.sleep("15 seconds"), undefined)
              : undefined,
        })
        const { walk, phases } = yield* phasedWalk(tab)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* TestClock.adjust("0 millis")
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
        assert.deepStrictEqual(phases.slice(0, 4), [
          { step: "awaiting-close", since: start },
          {
            step: "awaiting-close",
            since: start,
            stall: { kind: "timeout", failures: 1, tokenChanged: false },
          },
          {
            step: "awaiting-close",
            since: start,
            stall: { kind: "timeout", failures: 2, tokenChanged: true },
          },
          { step: "awaiting-close", since: start },
        ])
      })
  )

  it.effect("never sends a cookie token past its expiry", () =>
    Effect.gen(function* () {
      const start = wib("2026-11-12", "17:30:00")
      yield* TestClock.setTime(start)
      const stale = jwt("stale", start / 1000 - 60)
      const page = jwt("page")
      const { tab, bearers } = signedTab({
        cookie: () => stale,
        token: () => page,
      })
      const walk = yield* walkWith(tab)
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      assert.isTrue(bearers.every((bearer) => bearer === page))
    })
  )
})
