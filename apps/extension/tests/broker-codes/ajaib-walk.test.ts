import { assert, describe, it } from "@effect/vitest"
import { WibDate, type BrokerCodesBatch } from "@workspace/relay"
import { Clock, Effect, Exit, Fiber, Option } from "effect"
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
    return OK({
      page: number,
      page_size: size,
      total_pages: 2,
      results: before.slice(offset, offset + size).map((row) => ({
        stock_code: "BBCA",
        trade_num: `${row.date.replaceAll("-", "")}${String(row.number).padStart(10, "0")}`,
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
  return {
    paths,
    attached: Effect.succeed(true),
    tapeCalls: () => paths.filter((path) => path !== STATUS_PATH),
    request: (request: TabRequest) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (request._tag === "page-token")
          return Option.some<Answer>({
            ...STATUS(200),
            body: options.token?.(now) ?? "token",
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

describe("Ajaib's walk of the day", () => {
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
    "leaves the day to Stockbit when the tape's newest row is another day's",
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
        assert.deepStrictEqual(yield* walk.walk(DAY), {
          _tag: "unserved",
          reason: "other-date",
        })
        assert.deepStrictEqual(production.batches, [])
      })
  )

  it.effect("leaves the day to Stockbit when no Ajaib tab is relayed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      const production = fakeProduction()
      const walk = yield* makeAjaibWalk({
        tab: {
          attached: Effect.succeed(false),
          request: () => Effect.succeed(Option.none<Answer>()),
        },
        post: production.post,
        store: memoryStore().store,
      })
      assert.deepStrictEqual(yield* walk.walk(DAY), {
        _tag: "unserved",
        reason: "no-tab",
      })
      assert.deepStrictEqual(production.batches, [])
    })
  )
})

describe("Ajaib's walk: stopping and carrying on", () => {
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

  it.effect("leaves the day to Stockbit when its Ajaib tab goes mid-walk", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:30:00"))
      let gone = false
      // The tab closes during the 40th call: it and any later get no answer.
      const fake = fakeAjaib({
        answer: (_, call) =>
          call >= 40
            ? Effect.sync(() => {
                gone = true
                return undefined
              })
            : undefined,
      })
      const walk = yield* makeAjaibWalk({
        tab: { ...fake, attached: Effect.sync(() => !gone) },
        post: fakeProduction().post,
        store: memoryStore().store,
      })
      const fiber = yield* Effect.forkChild(walk.walk(DAY))
      yield* settle(fake, 40)
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual(
        fiber.pollUnsafe(),
        Exit.succeed({ _tag: "unserved", reason: "no-tab" })
      )
      assert.lengthOf(fake.paths, 40)
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
})
