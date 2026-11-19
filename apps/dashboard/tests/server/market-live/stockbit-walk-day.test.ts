// A seeded fuzz of the extension's Stockbit walk against the real trading
// day: a tape in Stockbit's order (numbers shuffled within each second),
// rows read with codes but no fields, walks and gap walks cut by a kill or
// a lost tab, often on such a row, over a walk, relay or History day. A
// clean full walk must then post every trade and the day's true N, and the
// gap walk must leave the day complete and built with every trade. Spec
// apinrdw/kumora#437; the review rounds that found each hole are in its PR
// #449.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  StockCode,
  WibDate,
  decodeBrokerCodesStatus,
  encodeBrokerCodesBatch,
  encodeIngestUp,
  type BrokerCodesBatch,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Clock, DateTime, Effect, Fiber, Layer, Option, Scope } from "effect"
import { TestClock } from "effect/testing"

import { readBrokerTotals } from "@/server/broker-totals/db"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import { makeStockbitWalk } from "../../../../extension/src/worker/broker-codes/stockbit-walk.ts"
import type {
  Answer,
  TabRequest,
} from "../../../../extension/src/worker/broker.ts"
import { memoryBrokerTotalsDb } from "../broker-totals/memory-broker-totals-db"
import { stockbitTrade } from "./day-harness"
import { runningTradeBatch } from "./protobuf"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")
const UNTR = StockCode.make("UNTR")
const PAGE = 100
const ms = (date: string, time: string) => Date.parse(`${date}T${time}+07:00`)
const env = Layer.succeed(WorkerEnv)({
  INGEST_TOKEN: TOKEN,
} as unknown as WorkerEnv["Service"])

class FakeSocket implements Peer {
  open = Effect.succeed(true)
  private current: PeerState = "new"
  send = () => Effect.void
  close = () => Effect.void
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
}

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("=", "")
const JWT = `${base64Url({ alg: "HS256" })}.${base64Url({ data: { uid: 7 }, name: "live" })}.sig`

const rng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const answer = (body: string): Option.Option<Answer> =>
  Option.some({ _tag: "answer", id: 0, status: 200, body })

const run = (seed: number) =>
  Effect.gen(function* () {
    const random = rng(seed * 104729 + 7)
    const log: Array<string> = []
    const n = 120 + Math.floor(random() * 1400)
    // The tape in Stockbit's order: seconds of 1..6 trades, numbers shuffled
    // within each second.
    const order: Array<number> = []
    const secondOf = new Map<number, number>()
    for (let next = 1, second = 0; next <= n; second++) {
      const size = Math.min(n - next + 1, 1 + Math.floor(random() * 6))
      const group = Array.from({ length: size }, (_, at) => next + at)
      for (let at = group.length - 1; at > 0; at--) {
        const swap = Math.floor(random() * (at + 1))
        ;[group[at], group[swap]] = [group[swap]!, group[at]!]
      }
      for (const number of group) secondOf.set(number, second)
      order.push(...group)
      next += size
    }
    const clockOf = (number: number) => {
      const second = 9 * 3600 + secondOf.get(number)!
      return [second / 3600, (second / 60) % 60, second % 60]
        .map((part) => String(Math.floor(part)).padStart(2, "0"))
        .join(":")
    }
    // Rows Stockbit sends with codes but unreadable lots until the clean
    // runs; often the last row of a page, where a cut lands, or of the day.
    const bad = new Set<number>()
    for (let count = Math.floor(random() * 6); count > 0; count--)
      bad.add(1 + Math.floor(random() * n))
    for (let end = PAGE - 1; end < order.length; end += PAGE)
      if (random() < 0.5) bad.add(order[end]!)
    if (random() < 0.5) bad.add(order.at(-1)!)
    if (random() < 0.5) bad.add(n)
    let dirty = true
    let calls = 0
    let cut: { at: number; kind: "kill" | "halt" } | undefined
    let attached = true
    const row = (number: number) => ({
      trade_number: String(number),
      time: clockOf(number),
      action: number % 2 === 0 ? "buy" : "sell",
      code: "UNTR",
      price: (23_000 + (number % 40) * 25).toLocaleString("en-US"),
      lot: dirty && bad.has(number) ? "n/a" : "3",
      market_board: "RG",
      is_broker_exists: true,
      buyer: "YP [D]",
      seller: " PD [F] ",
      buyer_type: "BROKER_TYPE_LOCAL",
      seller_type: "BROKER_TYPE_FOREIGN",
    })
    const tab = {
      attached: Effect.sync(() => attached),
      request: (request: TabRequest) =>
        Effect.gen(function* () {
          if (request._tag === "cookie")
            return answer(encodeURIComponent(JSON.stringify({ token: JWT })))
          if (request._tag !== "fetch") return Option.none<Answer>()
          calls++
          if (cut !== undefined && calls >= cut.at) {
            if (cut.kind === "kill") return yield* Effect.never
            attached = false
            return Option.none<Answer>()
          }
          const params = new URL(request.url).searchParams
          const limit = Number(params.get("limit"))
          let rows: Array<number>
          if (params.get("sort") === "DESC")
            rows = order.slice(-limit).reverse()
          else {
            const cursor = params.get("trade_number")
            const from = cursor === null ? 0 : order.indexOf(Number(cursor)) + 1
            rows =
              from === 0 && cursor !== null
                ? []
                : order.slice(from, from + limit)
          }
          return answer(
            JSON.stringify({
              data: { is_open_market: false, running_trade: rows.map(row) },
            })
          )
        }),
    }

    const db = memoryBrokerTotalsDb()
    let pending: number | undefined
    const kind = (["walk", "relay", "history"] as const)[
      Math.floor(random() * 3)
    ]!
    yield* TestClock.setTime(
      ms(DAY, kind === "relay" ? "09:30:00" : "17:30:00")
    )
    const relays: Array<FakeSocket> = []
    const day = yield* makeTradingDay({
      sql: memorySql(),
      date: DAY,
      viewers: Effect.succeed([]),
      viewersOf: () => Effect.succeed([]),
      ingests: Effect.sync(() => relays),
      setAlarm: (at) =>
        Effect.sync(() => {
          pending = DateTime.toEpochMillis(at)
        }),
      brokerTotalsDb: db.layer,
    }).pipe(Scope.provide(yield* Scope.make()))
    // Rings every alarm due by now, as the Durable Object would.
    const fire = Effect.gen(function* () {
      let rings = 0
      while (
        pending !== undefined &&
        pending <= (yield* Clock.currentTimeMillis)
      ) {
        if (++rings > 500) return yield* Effect.die("alarm hot loop")
        pending = undefined
        yield* day.alarm.pipe(Effect.provide(env))
      }
    })
    if (kind === "relay") {
      const relay = new FakeSocket()
      relays.push(relay)
      yield* day
        .ingestMessage(
          relay,
          yield* encodeIngestUp({
            _tag: "Token",
            protocolVersion: IngestProtocolVersion,
            token: TOKEN,
          })
        )
        .pipe(Effect.provide(env))
      const taped = order.filter(() => random() < 0.7).sort((a, b) => a - b)
      for (let at = 0; at < taped.length; at += 200)
        yield* day
          .ingestMessage(
            relay,
            yield* encodeIngestUp({
              _tag: "Frames",
              protocolVersion: IngestProtocolVersion,
              feed: "Stockbit",
              connection: "A",
              receivedAt: DateTime.makeUnsafe(ms(DAY, "09:30:00")),
              frames: [
                runningTradeBatch(
                  taped.slice(at, at + 200).map((number) =>
                    stockbitTrade({
                      number,
                      time: `${clockOf(number)}.000`,
                      price: 23_000 + (number % 40) * 25,
                      lots: 3,
                      side: number % 2 === 0 ? "buy" : "sell",
                    })
                  )
                ),
              ],
            })
          )
          .pipe(Effect.provide(env))
      yield* TestClock.adjust(70_000)
      yield* TestClock.setTime(ms(DAY, "17:00:00"))
      yield* fire
      yield* TestClock.setTime(ms(DAY, "17:30:00"))
    }
    if (kind === "history")
      yield* TestClock.setTime(ms("2026-11-10", "20:00:00"))
    yield* fire

    const status = (after = "0") =>
      Effect.gen(function* () {
        const response = yield* day.brokerCodes
          .status(new URLSearchParams({ after }))
          .pipe(Effect.provide(env))
        return yield* decodeBrokerCodesStatus(
          yield* Effect.promise(() => response.text())
        )
      }).pipe(Effect.orDie)
    const posted = new Set<number>()
    const walk = yield* makeStockbitWalk({
      tab,
      post: (batch: BrokerCodesBatch) =>
        Effect.gen(function* () {
          const response = yield* day.brokerCodes.post(
            yield* encodeBrokerCodesBatch(batch).pipe(Effect.orDie)
          )
          for (const [number] of batch.rows) posted.add(Number(number))
          yield* fire
          return response.status === 200
            ? ("sent" as const)
            : yield* Effect.die(`post ${response.status}`)
        }),
      status: (_day, after) => status(after ?? "0"),
    })

    const pages = Math.ceil(n / PAGE)
    const attempts = Math.floor(random() * 4)
    for (let attempt = 0; attempt < attempts; attempt++) {
      calls = 0
      attached = true
      cut = {
        at: 2 + Math.floor(random() * (pages + 3)),
        kind: random() < 0.5 ? "kill" : "halt",
      }
      const which = random() < 0.7 ? "walk" : "gaps"
      let ended = false
      const fiber = yield* Effect.forkChild(
        (which === "walk" ? walk.walk(DAY) : walk.gaps(DAY)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ended = true
            })
          )
        )
      )
      // Until the walk reaches its cut or ends before it.
      while (!ended && calls < cut.at) yield* Effect.yieldNow
      if (cut.kind === "kill") yield* Fiber.interrupt(fiber)
      else yield* Fiber.join(fiber)
      const now = yield* status()
      log.push(
        `${which} cut ${cut.kind}@${cut.at}: n=${now.n} complete=${now.complete} missing=${JSON.stringify(now.missing.slice(0, 4))} count=${now.missingCount} codes=${now.sources.stockbit}`
      )
    }

    // The clean runs: nothing cut, and Stockbit's rows read whole from the
    // full walk on or from the gap walk on.
    if (random() < 0.5) dirty = false
    cut = undefined
    attached = true
    calls = 0
    const walked = yield* walk.walk(DAY)
    const afterWalk = yield* status()
    log.push(
      `full walk (dirty=${dirty}) -> ${walked._tag}: n=${afterWalk.n} complete=${afterWalk.complete} missing=${JSON.stringify(afterWalk.missing.slice(0, 4))}`
    )
    const unposted = order.filter((number) => !posted.has(number))
    dirty = false
    const gapped = yield* walk.gaps(DAY)
    yield* fire
    const afterGaps = yield* status()
    log.push(
      `gap walk -> ${gapped._tag}: n=${afterGaps.n} complete=${afterGaps.complete} missing=${JSON.stringify(afterGaps.missing.slice(0, 4))}`
    )
    yield* TestClock.adjust("10 minutes")
    yield* fire
    const built = yield* readBrokerTotals(UNTR, DAY, DAY).pipe(
      Effect.provide(db.layer)
    )

    const problems: Array<string> = []
    if (unposted.length > 0)
      problems.push(
        `the full walk never posted ${JSON.stringify(unposted.slice(0, 6))}`
      )
    if (Number(afterWalk.n) !== n)
      problems.push(`the full walk's n ${afterWalk.n} of ${n}`)
    if (!afterGaps.complete) problems.push("incomplete after the gap walk")
    else if (built.candles[0]?.trades !== n)
      problems.push(`built ${built.candles[0]?.trades} of ${n} trades`)
    return {
      failure:
        problems.length === 0
          ? undefined
          : `${kind} day: ${problems.join("; ")}`,
      log,
    }
  })

describe("the extension's Stockbit walk over a trading day", () => {
  it.effect.each(Array.from({ length: 64 }, (_, seed) => seed))(
    "seed %s posts every trade and leaves the day complete and built",
    (seed) =>
      Effect.gen(function* () {
        const { failure, log } = yield* run(seed)
        assert.isUndefined(failure, `${failure}\n${log.join("\n")}`)
      })
  )
})
