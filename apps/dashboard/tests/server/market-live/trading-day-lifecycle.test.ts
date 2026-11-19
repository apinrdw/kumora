// A seeded fuzz of a trading day's lifecycle: relay trades, walk batches
// with and without fields, code corrections, clock moves across 17:00,
// restarts, failing transactions and D1 batches, reconcile pokes, from fresh
// days and from days shaped as older revisions stored them. A run's
// unfillable trades, as many as the build gate allows, no walk ever sends.
// Every run then settles (failures healed, every other trade walked) and
// must end sealed, listed and built with the kept codes' totals and its
// unfillable trades missing. A sealed day's answers must never change, and
// a day with a built row and no build due must be buildable with the row's
// missing count.
// Spec apinrdw/kumora#437 and #457; the review rounds that found each hole
// are in its PR #449.
import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  IngestProtocolVersion,
  StockCode,
  TradeNumber,
  WibDate,
  decodeBrokerCodesStatus,
  encodeBrokerCodesBatch,
  encodeIngestUp,
  type RecordedDay,
  type TradeFields,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Clock, DateTime, Effect, Exit, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

import { readBrokerTotals } from "@/server/broker-totals/db"
import { MISSING_ALLOWANCE } from "@/server/market-live/broker-codes"
import type { Sql } from "@/server/market-live/day-store"
import { makeTape } from "@/server/market-live/tape"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import { memoryBrokerTotalsDb } from "../broker-totals/memory-broker-totals-db"
import { stockbitTrade } from "./day-harness"
import { runningTradeBatch } from "./protobuf"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")
const NEXT_DAY = "2026-11-10"
const UNTR = StockCode.make("UNTR")
const ms = (date: string, time: string) => Date.parse(`${date}T${time}+07:00`)
const SEAL = ms(DAY, "17:00:00")
const WALKS_FROM = ms(DAY, "16:35:00")
const RELAY_FROM = ms(DAY, "08:45:00")
// The day's trades: M slots of a mode's `slot` trades each, trade n of n
// lots. The fuzz picks slots; a slot's trades go together.
const M = 12

// What a run varies beyond its seed.
interface Mode {
  // The trades a slot holds. A day of at least 1,000 trades has
  // unfillable ones, at most 1 in 1,000.
  readonly slot: number
  // A walk's `end` can name M - 2..M, as two sites' walks end apart.
  readonly variableN: boolean
  // The day starts as an older revision stored it.
  readonly legacy: boolean
  // Alarms ring late, skipped after some steps.
  readonly lazyAlarms: boolean
  // The object starts before the walks, while the relay can still stream.
  readonly early: boolean
  // Walks send the last slot only at settle, and an `end` names it only once
  // the day is built, which pushes the built day past the build gate.
  readonly lastSlotAtSettle?: boolean
}

const LEGACY_DAYS = [
  "none",
  "history",
  "history-sealed",
  "relay",
  "relay-sealed",
  "empty-sealed",
] as const

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

const env = Layer.succeed(WorkerEnv)({
  INGEST_TOKEN: TOKEN,
} as unknown as WorkerEnv["Service"])

const clockOf = (n: number) => {
  const second = 9 * 3600 + n * 7
  return [second / 3600, (second / 60) % 60, second % 60]
    .map((part) => String(Math.floor(part)).padStart(2, "0"))
    .join(":")
}

const fieldsOf = (n: number): TradeFields => ({
  time: DateTime.makeUnsafe(`${DAY}T${clockOf(n)}+07:00`),
  code: UNTR,
  price: 23_000 + n * 25,
  lots: n,
  board: "RG",
  side: n % 2 === 0 ? "buy" : "sell",
})

const relayedTrades = (numbers: ReadonlyArray<number>) =>
  runningTradeBatch(
    numbers.map((n) =>
      stockbitTrade({
        number: n,
        time: `${clockOf(n)}.000`,
        price: fieldsOf(n).price,
        lots: n,
        side: n % 2 === 0 ? "buy" : "sell",
      })
    )
  )

const rng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const run = (seed: number, mode: Mode) =>
  Effect.gen(function* () {
    const random = rng(seed * 7919 + 13)
    const B = mode.slot
    const T = M * B
    const tradesOf = (slots: ReadonlyArray<number>) =>
      slots.flatMap((slot) =>
        Array.from({ length: B }, (_, offset) => (slot - 1) * B + offset + 1)
      )
    // Its own stream, so a seed's steps stay as they were before it.
    const unfillableRandom = rng(seed * 104_729 + 7)
    const unfillable = new Set(
      Array.from(
        {
          length: Math.floor(unfillableRandom() * (Math.floor(T / 1_000) + 1)),
        },
        () => 1 + Math.floor(unfillableRandom() * T)
      )
    )
    const fillable = Array.from({ length: T }, (_, at) => at + 1).filter(
      (n) => !unfillable.has(n)
    )
    const pick = <T>(items: ReadonlyArray<T>) =>
      items[Math.floor(random() * items.length)]!
    const log: Array<string> = [`unfillable ${JSON.stringify([...unfillable])}`]
    const base = memorySql()
    const flaky = { failing: false }
    const sql: Sql = {
      exec: base.exec,
      transaction: (write) => {
        // The storage API is synchronous and throws; runSync throws the failure.
        if (flaky.failing)
          return Effect.runSync(Effect.fail(new Error("Storage write failed")))
        base.transaction(write)
      },
    }
    const db = memoryBrokerTotalsDb()
    let pending: number | undefined
    const indexed: Array<RecordedDay> = []
    const startWith = (withDb: boolean) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const relays: Array<FakeSocket> = []
        const day = yield* makeTradingDay({
          sql,
          date: DAY,
          viewers: Effect.succeed([]),
          viewersOf: () => Effect.succeed([]),
          ingests: Effect.sync(() => relays),
          setAlarm: (at) =>
            Effect.sync(() => {
              pending = DateTime.toEpochMillis(at)
            }),
          recordDay: (row) => Effect.sync(() => void indexed.push(row)),
          ...(withDb ? { brokerTotalsDb: db.layer } : {}),
        }).pipe(Scope.provide(scope))
        return { day, scope, relays }
      })
    const start = startWith(true)
    const token = encodeIngestUp({
      _tag: "Token",
      protocolVersion: IngestProtocolVersion,
      token: TOKEN,
    })
    const relayFrames = (numbers: ReadonlyArray<number>, at: number) =>
      encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Stockbit",
        connection: "A",
        receivedAt: DateTime.makeUnsafe(at),
        frames: [relayedTrades(numbers)],
      })

    const legacy = mode.legacy ? pick(LEGACY_DAYS) : "none"
    log.push(`legacy ${legacy}`)
    if (legacy === "history" || legacy === "history-sealed") {
      // A History day before #437: codes and walk_trades for 1..M, no tape.
      yield* TestClock.setTime(ms(NEXT_DAY, "20:00:00"))
      const old = yield* startWith(false)
      yield* old.day.brokerCodes.post(
        yield* encodeBrokerCodesBatch({
          version: BrokerCodesProtocolVersion,
          feed: "Stockbit",
          day: DAY,
          rows: fillable.map(
            (n) =>
              [
                TradeNumber.make(String(n)),
                {
                  buyer: BrokerCode.make("AK"),
                  buyerType: "F" as const,
                  seller: BrokerCode.make("CC"),
                  sellerType: "D" as const,
                },
              ] as const
          ),
          end: { n: TradeNumber.make(String(T)) },
        })
      )
      yield* Scope.close(old.scope, Exit.void)
      for (const n of fillable)
        base.exec(
          "INSERT INTO walk_trades VALUES (?, ?, ?, ?, ?)",
          n,
          UNTR,
          fieldsOf(n).price,
          n,
          "RG"
        )
      if (legacy === "history-sealed")
        base.exec(
          "INSERT OR REPLACE INTO facts VALUES ('sealed', '2026-11-09T10:00:00.000Z')"
        )
    }
    if (
      legacy === "relay" ||
      legacy === "relay-sealed" ||
      legacy === "empty-sealed"
    ) {
      yield* TestClock.setTime(ms(DAY, "09:30:00"))
      const old = yield* startWith(false)
      if (legacy !== "empty-sealed") {
        const relay = new FakeSocket()
        old.relays.push(relay)
        yield* old.day
          .ingestMessage(relay, yield* token)
          .pipe(Effect.provide(env))
        const numbers = [
          ...new Set(
            Array.from({ length: 6 }, () => 1 + Math.floor(random() * M))
          ),
        ].sort((a, b) => a - b)
        log.push(`legacy relay ${JSON.stringify(numbers)}`)
        yield* old.day
          .ingestMessage(
            relay,
            yield* relayFrames(tradesOf(numbers), ms(DAY, "09:30:00"))
          )
          .pipe(Effect.provide(env))
        yield* TestClock.adjust(70_000)
      }
      if (legacy !== "relay") {
        yield* TestClock.setTime(SEAL)
        if (legacy === "empty-sealed")
          base.exec(
            "INSERT OR REPLACE INTO facts VALUES ('sealed', '2026-11-09T10:00:00.000Z')"
          )
        else yield* old.day.alarm.pipe(Effect.provide(env))
      }
      yield* Scope.close(old.scope, Exit.void)
    }
    if (legacy !== "none") {
      // The facts this revision added, which an older one never wrote.
      base.exec(
        "DELETE FROM facts WHERE key IN ('tape-source','seal-wake','build-wake','broker-totals')"
      )
      indexed.length = 0
      pending = undefined
    }

    const starts = [
      ms(DAY, "08:50:00"),
      ms(DAY, "12:00:00"),
      ms(DAY, "16:40:00"),
      ms(DAY, "16:58:00"),
      ms(DAY, "17:10:00"),
      ms(DAY, "19:00:00"),
      ms(NEXT_DAY, "07:00:00"),
      ms(NEXT_DAY, "20:00:00"),
      ms("2026-11-11", "20:00:00"),
    ]
    const earliest = yield* Clock.currentTimeMillis
    let now = pick(
      (mode.early ? starts.slice(0, 2) : starts).filter(
        (time) => time >= earliest
      )
    )
    yield* TestClock.setTime(now)
    log.push(`start ${new Date(now).toISOString()}`)
    let object = yield* start
    let socket: FakeSocket | undefined

    // Rings every alarm due by now, as the Durable Object would.
    const fire = Effect.gen(function* () {
      let rings = 0
      while (pending !== undefined && pending <= now) {
        if (++rings > 200) return yield* Effect.die("alarm hot loop")
        pending = undefined
        log.push(`  alarm @${new Date(now).toISOString().slice(11, 19)}`)
        yield* object.day.alarm.pipe(Effect.provide(env))
      }
    })
    const advance = (by: number) =>
      Effect.gen(function* () {
        const target = now + by
        while (now < target) {
          const next =
            pending !== undefined && pending > now && pending < target
              ? pending
              : target
          yield* TestClock.adjust(next - now)
          now = next
          yield* fire
        }
      })
    const factOf = (key: string) => {
      const [row] = base.exec("SELECT value FROM facts WHERE key = ?", key)
      return row === undefined ? undefined : String(row.value)
    }
    const builtRow = () =>
      db.database
        .prepare("SELECT missing_trades AS missing FROM built_days")
        .get() as { missing: number } | undefined
    const status = Effect.gen(function* () {
      const response = yield* object.day.brokerCodes.status(
        new URLSearchParams()
      )
      return yield* decodeBrokerCodesStatus(
        yield* Effect.promise(() => response.text())
      )
    })
    // The sealed day's tape and candles answers, which must never change.
    const answer = Effect.gen(function* () {
      const tape = yield* object.day
        .recorded({ _tag: "Tape", at: DateTime.makeUnsafe(SEAL) })
        .pipe(Effect.provide(env))
      const candles = yield* object.day
        .recorded({ _tag: "Candles", code: UNTR })
        .pipe(Effect.provide(env))
      return `${yield* Effect.promise(() => tape.text())}|${yield* Effect.promise(() => candles.text())}`
    })
    // A batch of `slots`' fillable trades, each slot with fields or not.
    const post = (
      feed: "Ajaib" | "Stockbit",
      slots: ReadonlyArray<readonly [number, boolean]>,
      end?: number,
      buyerOf: (n: number) => string = () => "AK"
    ) =>
      Effect.gen(function* () {
        const rows = slots.flatMap(([slot, fielded]) =>
          tradesOf([slot])
            .filter((n) => !unfillable.has(n))
            .map((n) => [n, fielded] as const)
        )
        const text = yield* encodeBrokerCodesBatch({
          version: BrokerCodesProtocolVersion,
          feed,
          day: DAY,
          rows: rows.map(([n, fielded]) => {
            const codes = {
              buyer: BrokerCode.make(buyerOf(n)),
              buyerType: "F" as const,
              seller: BrokerCode.make("CC"),
              sellerType: "D" as const,
            }
            const number = TradeNumber.make(String(n))
            return fielded
              ? ([number, codes, fieldsOf(n)] as const)
              : ([number, codes] as const)
          }),
          ...(end === undefined
            ? {}
            : { end: { n: TradeNumber.make(String(end)) } }),
        })
        const exit = yield* Effect.exit(object.day.brokerCodes.post(text))
        log.push(
          `post ${feed} ${JSON.stringify(slots.map(([n, f]) => (f ? n : `${n}c`)))} end=${end} -> ${Exit.isSuccess(exit) ? exit.value.status : "threw"}`
        )
      })
    const subset = (most: number) => {
      const numbers = new Set<number>()
      for (let at = 1 + Math.floor(random() * most); at > 0; at--)
        numbers.add(1 + Math.floor(random() * M))
      return [...numbers].sort((a, b) => a - b)
    }

    let sealedAnswer: string | undefined
    const steps = 10 + Math.floor(random() * 30)
    for (let step = 0; step < steps; step++) {
      const roll = random()
      if (roll < 0.25) {
        const by = pick([
          1_000, 30_000, 120_000, 360_000, 1_800_000, 10_800_000,
        ])
        log.push(`advance ${by / 1000}s`)
        yield* advance(by)
      } else if (roll < 0.4) {
        if (now >= RELAY_FROM && now < WALKS_FROM) {
          if (socket === undefined) {
            socket = new FakeSocket()
            object.relays.push(socket)
            yield* object.day
              .ingestMessage(socket, yield* token)
              .pipe(Effect.provide(env))
          }
          const numbers = subset(4)
          log.push(`relay ${JSON.stringify(numbers)}`)
          yield* Effect.exit(
            object.day
              .ingestMessage(socket, yield* relayFrames(tradesOf(numbers), now))
              .pipe(Effect.provide(env))
          )
        }
      } else if (roll < 0.7) {
        if (now >= WALKS_FROM) {
          const rows = subset(6)
            .map((n) => [n, random() < 0.9] as const)
            .filter(([n]) => !mode.lastSlotAtSettle || n !== M)
          const end =
            random() < 0.3
              ? mode.lastSlotAtSettle
                ? builtRow() === undefined
                  ? T - B
                  : T
                : mode.variableN
                  ? (M - Math.floor(random() * 3)) * B
                  : T
              : undefined
          const corrected = new Set(
            rows.filter(() => random() < 0.3).map(([slot]) => slot)
          )
          yield* post(pick(["Ajaib", "Stockbit"] as const), rows, end, (n) =>
            corrected.has(Math.ceil(n / B)) ? "YP" : "AK"
          )
        }
      } else if (roll < 0.8) {
        log.push("restart")
        yield* advance(70_000)
        yield* Scope.close(object.scope, Exit.void)
        socket = undefined
        object = yield* start
      } else if (roll < 0.85) {
        db.failBatch = db.failBatch === undefined ? () => true : undefined
        log.push(`db failing=${db.failBatch !== undefined}`)
      } else if (roll < 0.9) {
        flaky.failing = !flaky.failing
        log.push(`sql failing=${flaky.failing}`)
      } else if (roll < 0.95) {
        const poked = yield* Effect.exit(object.day.brokerTotals.reconcile)
        log.push(`poke -> ${Exit.isSuccess(poked) ? poked.value : "threw"}`)
      } else {
        yield* Effect.exit(status)
      }
      if (!mode.lazyAlarms || random() < 0.6) yield* fire
      if (!flaky.failing && factOf("build-wake") === undefined) {
        const row = builtRow()
        if (row !== undefined) {
          const { n, missingCount } = yield* status
          if (n === null || missingCount * MISSING_ALLOWANCE > Number(n))
            return { failure: `built but not buildable at ${n}`, log }
          if (row.missing !== missingCount)
            return {
              failure: `built missing ${row.missing} != ${missingCount}`,
              log,
            }
        }
      }
      if (factOf("sealed") !== undefined && !flaky.failing) {
        const text = yield* answer
        if (sealedAnswer === undefined) {
          sealedAnswer = text
          log.push("sealed")
        } else if (sealedAnswer !== text)
          return { failure: "sealed answer changed", log }
      } else if (sealedAnswer !== undefined && factOf("sealed") === undefined)
        return { failure: "unsealed", log }
    }

    log.push("settle")
    db.failBatch = undefined
    flaky.failing = false
    if (now < SEAL) yield* advance(SEAL - now)
    yield* post(
      "Stockbit",
      Array.from({ length: M }, (_, at) => [at + 1, true] as const),
      T
    )
    yield* fire
    for (let minute = 0; minute < 20; minute++) yield* advance(60_000)

    const final = yield* status
    const built = yield* readBrokerTotals(UNTR, DAY, DAY).pipe(
      Effect.provide(db.layer)
    )
    const tapeTrades = yield* makeTape(base).count
    const kept = new Map<string, number>()
    for (let n = 1; n <= T; n++) {
      const held = yield* object.day.brokerCodes.held(
        TradeNumber.make(String(n))
      )
      if (held._tag === "Some")
        kept.set(
          held.value.codes.buyer,
          (kept.get(held.value.codes.buyer) ?? 0) + n
        )
    }
    const bought = new Map<string, number>()
    for (const row of built.totals)
      if (row.buyLots > 0)
        bought.set(row.broker, (bought.get(row.broker) ?? 0) + row.buyLots)
    const show = (lots: Map<string, number>) => JSON.stringify([...lots].sort())

    const problems: Array<string> = []
    if (final.n !== String(T) || final.missingCount !== unfillable.size)
      problems.push(`short ${JSON.stringify(final)}`)
    if (factOf("sealed") === undefined) problems.push("not sealed")
    if (built.builtDays.length !== 1) problems.push("not built")
    else {
      if (show(kept) !== show(bought))
        problems.push(`totals ${show(bought)} != kept ${show(kept)}`)
      const volume = fillable.reduce((sum, n) => sum + n, 0)
      if (
        built.candles[0]?.volume !== volume ||
        built.candles[0]?.trades !== fillable.length ||
        built.builtDays[0]?.missingTrades !== unfillable.size
      )
        problems.push(
          `built wrong ${JSON.stringify([built.candles, built.builtDays])}`
        )
    }
    // An older revision's relay seal wrote its index row before this run.
    if (tapeTrades > 0 && indexed.length === 0 && legacy !== "relay-sealed")
      problems.push("not indexed")
    if (indexed.length > 0 && indexed.at(-1)!.trades !== tapeTrades)
      problems.push(`index trades ${indexed.at(-1)!.trades} != ${tapeTrades}`)
    if (sealedAnswer !== undefined && sealedAnswer !== (yield* answer))
      problems.push("sealed answer changed at settle")
    if (pending !== undefined && pending <= now) problems.push("alarm pending")
    return {
      failure: problems.length === 0 ? undefined : problems.join("; "),
      log,
    }
  })

// A slot of 170 trades makes a day of 2,040, up to 2 of them unfillable.
const UNFILLABLE = 170

const MODES: Array<[string, Mode, number]> = [
  [
    "fixed N",
    {
      slot: 1,
      variableN: false,
      legacy: false,
      lazyAlarms: false,
      early: false,
    },
    60,
  ],
  [
    "varying N",
    {
      slot: 1,
      variableN: true,
      legacy: false,
      lazyAlarms: false,
      early: false,
    },
    200,
  ],
  [
    "varying N, older revisions' days",
    { slot: 1, variableN: true, legacy: true, lazyAlarms: false, early: false },
    80,
  ],
  [
    "varying N, late alarms",
    { slot: 1, variableN: true, legacy: false, lazyAlarms: true, early: false },
    100,
  ],
  [
    "varying N, started before the walks",
    { slot: 1, variableN: true, legacy: false, lazyAlarms: true, early: true },
    60,
  ],
  [
    "an end raised past a built day's last slot",
    {
      slot: 1,
      variableN: true,
      legacy: false,
      lazyAlarms: false,
      early: false,
      lastSlotAtSettle: true,
    },
    60,
  ],
  [
    "unfillable trades, varying N",
    {
      slot: UNFILLABLE,
      variableN: true,
      legacy: false,
      lazyAlarms: false,
      early: false,
    },
    40,
  ],
  [
    "unfillable trades, older revisions' days, late alarms",
    {
      slot: UNFILLABLE,
      variableN: true,
      legacy: true,
      lazyAlarms: true,
      early: false,
    },
    40,
  ],
]

describe.each(MODES)("trading day lifecycle, %s", (_name, mode, seeds) => {
  it.effect.each(Array.from({ length: seeds }, (_, seed) => seed))(
    "seed %s settles sealed and built, its unfillable trades missing",
    (seed) =>
      Effect.gen(function* () {
        const { failure, log } = yield* run(seed, mode)
        assert.isUndefined(failure, `${failure}\n${log.join("\n")}`)
      }),
    // A day of 2,040 trades takes up to ~2.5 s a seed here.
    mode.slot === 1 ? undefined : 10_000
  )
})
