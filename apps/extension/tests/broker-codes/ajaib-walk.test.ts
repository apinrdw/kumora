import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
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
import type { PostOutcome } from "../../src/worker/broker-codes/poster.ts"
import type { Answer, TabRequest } from "../../src/worker/broker.ts"

const DAY = WibDate.make("2026-11-12")
const wib = (date: string, time: string) => Date.parse(`${date}T${time}+07:00`)
const MINUTE = 60_000

// A Thursday's tape: the opening match's 100 trades sharing one ms, 100
// quiet trades through the day, then a busy 16:00 block (12,000 trades, three
// pages of 5,000) and a 16:15 block that takes two pages. Trade numbers rise
// with time.
// The busy blocks come last, so the quiet blocks the walk reaches
// after them answer only the few older rows. A 5,000-row page for each of the
// day's ~160 blocks timed this file out on CI's 2 cores.
const dayTrades = () => {
  const times: Array<number> = []
  for (let at = 0; at < 100; at++) times.push(wib("2026-11-12", "08:58:00"))
  for (let at = 0; at < 100; at++)
    times.push(wib("2026-11-12", "09:00:00") + at * 4 * MINUTE)
  for (let at = 0; at < 12_000; at++)
    times.push(wib("2026-11-12", "16:00:00") + at * 10)
  for (let at = 0; at < 6_000; at++)
    times.push(wib("2026-11-12", "16:15:00") + at * 20)
  return times
}
const N = 18_200
const TIMES = dayTrades()
// Decision: a walk of this whole day is slow on purpose, so these tests set
// their own timeout. On CI's 2 cores each took about 4.9 s against the 5 s
// default (local ~0.9 s), and timed out on apinrdw/kumora#527, which touched no
// extension code; 15 s keeps about 3x headroom.
const WALK_TIMEOUT = 15_000
// The tape calls the codes-only walk made of this day.
const CALLS = 166

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

// Ajaib's REST tape as probed on 2026-11-12 (apinrdw/kumora#192):
// `last_timestamp` floors to a 3-minute boundary and the answer holds rows
// strictly before it, newest first; page p starts at (p - 1) × (size + 1),
// so each seam drops one row; `total_pages` always says 2.
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
    // Trades the tape sends with codes but zero lots.
    readonly badLots?: ReadonlySet<number>
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
    const at = paramOf(path, "last_timestamp")
    const number = paramOf(path, "page")
    const size = sizeOf(path)
    const floor = Math.floor(at / (3 * MINUTE)) * 3 * MINUTE
    const before = rows.filter((row) => row.timestamp < floor)
    const offset = (number - 1) * (size + 1)
    const malformed = options.malformed?.(path) ?? false
    return OK({
      page: number,
      page_size: size,
      total_pages: 2,
      results: before.slice(offset, offset + size).map((row, index) => ({
        stock_code: fieldsOf(row.number).code,
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

const missingOf = (held: ReadonlySet<number>) => {
  const missing: Array<number> = []
  for (let number = 1; number <= N; number++)
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

describe("Ajaib's walk of the day", { timeout: WALK_TIMEOUT }, () => {
  it.effect(
    "posts every trade 1..N, then end, with the repair pass closing the page seams",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        let beforeRepair = new Set<number>()
        const production = fakeProduction()
        const tab = fakeAjaib({
          answer: (request) => {
            if (
              request._tag === "page-fetch" &&
              sizeOf(request.path) === 4_999 &&
              beforeRepair.size === 0
            )
              beforeRepair = production.held()
            return undefined
          },
        })
        const walk = yield* walkWith(tab, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
        // As many calls as before walks posted fields (apinrdw/kumora#440).
        assert.lengthOf(tab.tapeCalls(), CALLS)
        // The first pass alone left one trade missing at each seam.
        assert.lengthOf(missingOf(beforeRepair), 3)
        assert.deepStrictEqual(production.ends(), [{ n: String(N) }])
        assert.deepStrictEqual(production.batches.at(-1)?.end, {
          n: String(N),
        })
        for (const batch of production.batches) {
          assert.isAtMost(batch.rows.length, 5_000)
          assert.strictEqual(batch.feed, "Ajaib")
          assert.strictEqual(batch.day, DAY)
        }
      })
  )

  it.effect(
    "pages on past a full page that holds a malformed row, and repairs its block",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        // The first pass's first page of the busy 16:00 block leads with a
        // row without a trade number; the repair pass's pages don't.
        const tab = fakeAjaib({
          malformed: (path) =>
            paramOf(path, "last_timestamp") === wib("2026-11-12", "16:03:00") &&
            sizeOf(path) === 5_000 &&
            paramOf(path, "page") === 1,
        })
        const walk = yield* walkWith(tab, production)
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
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
          fakeAjaib({ badLots: new Set([7, 12_345]) }),
          production
        )
        assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(missingOf(production.held()), [])
        const fields = production.fields()
        assert.strictEqual(fields.size, N - 2)
        assert.isFalse(fields.has(7))
        assert.isFalse(fields.has(12_345))
      })
  )

  it.effect("says how many trades of N its first pass fetched", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const trades: Array<[number, Option.Option<number>]> = []
      const walk = yield* makeAjaibWalk({
        tab: fakeAjaib(),
        post: fakeProduction().post,
        store: memoryStore().store,
        trades: (fetched, of) =>
          Effect.sync(() => {
            trades.push([fetched, of])
          }),
      })
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      // Each of the first pass's three page seams dropped one trade.
      assert.deepStrictEqual(trades.at(-1), [N - 3, Option.some(N)])
    })
  )
})

describe("Ajaib's walk: when it starts", { timeout: WALK_TIMEOUT }, () => {
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

  it.effect("on a 401 takes the cookie's token and walks the day with it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      const fresh = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"
      const bearers: Array<string | undefined> = []
      const tab = fakeAjaib({
        cookie: () => encodeURIComponent(`"${fresh}"`),
        answer: (request) => {
          if (request._tag !== "page-fetch") return undefined
          bearers.push(request.bearer)
          return request.bearer === fresh
            ? undefined
            : Effect.succeed(STATUS(401))
        },
      })
      const walk = yield* walkWith(tab, production)
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      assert.deepStrictEqual(missingOf(production.held()), [])
      assert.strictEqual(bearers[0], undefined)
      assert.isTrue(bearers.slice(1).every((bearer) => bearer === fresh))
      assert.strictEqual(tab.reloads(), 0)
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

describe(
  "Ajaib's walk: stopping and carrying on",
  { timeout: WALK_TIMEOUT },
  () => {
    it.effect("a restarted worker carries on from the kept block", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        const kept = memoryStore()
        // The worker stops during the 60th call.
        const first = fakeAjaib({
          answer: (_, call) => (call === 60 ? Effect.never : undefined),
        })
        const before = yield* walkWith(first, production, kept.store)
        const fiber = yield* Effect.forkChild(before.walk(DAY))
        yield* settle(first, 60)
        yield* Fiber.interrupt(fiber)
        const position = kept.held()
        assert.isTrue(Option.isSome(position))
        const next = Option.getOrThrow(position).next

        const second = fakeAjaib()
        const after = yield* walkWith(second, production, kept.store)
        assert.deepStrictEqual(yield* after.walk(DAY), { _tag: "walked" })
        const blocks = second
          .tapeCalls()
          .filter((path) => sizeOf(path) === 5_000)
          .map((path) => paramOf(path, "last_timestamp"))
        // No block before the kept one is walked again.
        assert.strictEqual(Math.max(...blocks), next)
        assert.deepStrictEqual(missingOf(production.held()), [])

        // A walked day isn't walked again.
        const third = fakeAjaib()
        const again = yield* walkWith(third, production, kept.store)
        assert.deepStrictEqual(yield* again.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(third.paths, [])
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
              call === 30 ? Effect.succeed(STATUS(401)) : undefined,
          })
          const walk = yield* walkWith(tab, production)
          const fiber = yield* Effect.forkChild(walk.walk(DAY))
          yield* settle(tab, 30)
          assert.lengthOf(tab.paths, 30)
          yield* TestClock.adjust("13 minutes")
          // 17:43: the page hasn't renewed its token, and the walk waits.
          assert.lengthOf(tab.paths, 30)
          yield* TestClock.adjust("1 minute")
          assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
          // The refused page is asked again once the token changed.
          assert.strictEqual(tab.paths[30], tab.paths[29])
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
            // The page renews its token while the 30th call is in flight,
            // whose answer is still the old token's 401.
            answer: (_, call) =>
              call === 30
                ? Effect.sync(() => {
                    token = "renewed"
                    return STATUS(401)
                  })
                : undefined,
          })
          const walk = yield* walkWith(tab, production)
          const fiber = yield* Effect.forkChild(walk.walk(DAY))
          yield* settle(tab, 30)
          yield* TestClock.adjust("10 seconds")
          yield* settle(tab, 31)
          assert.isAbove(tab.paths.length, 30)
          assert.strictEqual(tab.paths[30], tab.paths[29])
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
          // The tab closes during the 40th call, which gets no answer.
          const fake = fakeAjaib({
            answer: (_, call) =>
              call === 40
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
          yield* settle(fake, 40)
          yield* TestClock.adjust("20 minutes")
          assert.isUndefined(fiber.pollUnsafe())
          assert.lengthOf(fake.paths, 40)
          gone = false
          yield* TestClock.adjust("1 minute")
          assert.deepStrictEqual(yield* Fiber.join(fiber), { _tag: "walked" })
          assert.strictEqual(fake.paths[40], fake.paths[39])
          assert.deepStrictEqual(missingOf(production.held()), [])
        })
    )

    it.effect("stops in place at 08:40, when Streaming hours start", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
        const production = fakeProduction()
        // The next morning arrives during the 50th call.
        const tab = fakeAjaib({
          answer: (_, call) =>
            call === 50
              ? Effect.as(
                  TestClock.setTime(wib("2026-11-13", "08:40:00")),
                  undefined
                )
              : undefined,
        })
        const walk = yield* walkWith(tab, production)
        const fiber = yield* Effect.forkChild(walk.walk(DAY))
        yield* settle(tab, 50)
        // The tab gave no answer, so the walk asks again in 10 s, and finds
        // Streaming hours started.
        yield* TestClock.adjust("10 seconds")
        assert.deepStrictEqual(yield* Fiber.join(fiber), {
          _tag: "stopped",
          cause: "streaming-hours",
        })
        assert.lengthOf(tab.paths, 50)
        assert.deepStrictEqual(production.ends(), [])
      })
    )
  }
)
