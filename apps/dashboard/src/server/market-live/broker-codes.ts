// A trading day's broker codes (spec apinrdw/kumora#244, "Dashboard:
// TradingDay's broker codes store"): the one kept copy of each trade's broker
// codes and investor types, the day's N, and the cross-check of Ajaib's copy
// against Stockbit's. It lives in the trading-day object's database beside
// the day store, in tables no recorded day answer reads.
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  decodeBrokerCodesBatch,
  encodeBrokerCodesStatus,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type CrossCheck,
  type TradeCodes,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { Fact, type Sql } from "./day-store.ts"

// Decision: chunk k holds trades 1000k+1 .. 1000k+1000 as 1,000 fixed 7-byte
// records: buyer code, buyer type, seller code, seller type, and the source.
// All zero bytes is an absent trade. A batch rewrites only the chunks it
// touches: 1–2 per Stockbit batch, up to 6 per Ajaib batch of 5,000.
const CHUNK = 1_000
const RECORD = 7
const SOURCE = 6

// Decision: the source byte is `A` for Ajaib's, `S` for Stockbit's, and `B`
// for Ajaib's that Stockbit's walk agreed with: the cross-check's covered
// trades are counted from it, so a resent Stockbit batch counts none twice.
const Source = { ajaib: 65, stockbit: 83, both: 66 } as const

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS broker_code_chunks (
    chunk INTEGER PRIMARY KEY,
    codes BLOB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cross_check_differences (
    number INTEGER PRIMARY KEY,
    ajaib BLOB NOT NULL,
    stockbit BLOB NOT NULL
  )`,
]

// Decision: the status reads the chunks this many at a time, so a 1.5M-trade
// day's ~10 MB of records never sits in memory at once.
const SCAN_PAGE = 64

// Stockbit's walk position and whether it ended, kept as the `cross-check`
// fact. `walkedTo` is the highest trade number Stockbit sent.
const CrossCheckFact = Schema.fromJsonString(
  Schema.Struct({ walkedTo: Schema.Number, ended: Schema.Boolean })
)
type CrossCheckFact = typeof CrossCheckFact.Type
const decodeCrossCheck = Schema.decodeUnknownOption(CrossCheckFact)
const encodeCrossCheck = Schema.encodeSync(CrossCheckFact)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Where a trade's record sits: its chunk and the record's offset in it.
const placeOf = (number: number) =>
  Effect.sync(() => ({
    chunk: Math.floor((number - 1) / CHUNK),
    at: ((number - 1) % CHUNK) * RECORD,
  }))

// One trade's codes as its record's first six bytes.
const bytesOf = (codes: TradeCodes) =>
  Effect.sync(() =>
    encoder.encode(
      `${codes.buyer}${codes.buyerType}${codes.seller}${codes.sellerType}`
    )
  )

// The codes a record's first six bytes hold, which the store wrote.
const codesOf = (record: Uint8Array) =>
  Effect.sync((): TradeCodes => {
    const text = decoder.decode(record.subarray(0, SOURCE))
    return {
      buyer: BrokerCode.make(text.slice(0, 2)),
      buyerType: text[2] === "F" ? "F" : "D",
      seller: BrokerCode.make(text.slice(3, 5)),
      sellerType: text[5] === "F" ? "F" : "D",
    }
  })

const sameCodes = (held: Uint8Array, at: number, codes: Uint8Array) =>
  Effect.sync(() => {
    for (let index = 0; index < SOURCE; index++)
      if (held[at + index] !== codes[index]) return false
    return true
  })

// An Ajaib row replaces what is held. A resent one keeps what Stockbit's
// walk agreed.
const mergeAjaib = Effect.fnUntraced(function* (
  held: Uint8Array,
  at: number,
  codes: Uint8Array
) {
  if (held[at + SOURCE] === Source.both && (yield* sameCodes(held, at, codes)))
    return
  held.set(codes, at)
  held[at + SOURCE] = Source.ajaib
})

// A Stockbit row fills an absent trade or replaces Stockbit's copy. For one
// held from Ajaib it only says whether the two agree.
const mergeStockbit = Effect.fnUntraced(function* (
  held: Uint8Array,
  at: number,
  codes: Uint8Array
) {
  const source = held[at + SOURCE]
  if (source !== Source.ajaib && source !== Source.both) {
    held.set(codes, at)
    held[at + SOURCE] = Source.stockbit
    return "kept" as const
  }
  const agrees = yield* sameCodes(held, at, codes)
  held[at + SOURCE] = agrees ? Source.both : Source.ajaib
  return agrees ? ("agreed" as const) : ("differs" as const)
})

// What a batch writes, in one transaction.
interface Merged {
  readonly chunks: Map<number, Uint8Array>
  readonly differences: Map<number, readonly [Uint8Array, Uint8Array]>
  readonly agreed: Set<number>
  readonly facts: Array<readonly [string, string]>
}

// What the status scan has counted so far.
interface Tally {
  // The lowest number not yet accounted for.
  next: number
  readonly limit: number
  readonly missing: Array<readonly [number, number]>
  ajaib: number
  stockbit: number
  covered: number
}

// One chunk's records into the tally, in trade number order.
const tallyChunk = (tally: Tally, chunk: number, codes: Uint8Array) =>
  Effect.sync(() => {
    for (let slot = 0; slot < CHUNK; slot++) {
      const source = codes[slot * RECORD + SOURCE]
      if (source === 0 || source === undefined) continue
      if (source === Source.stockbit) tally.stockbit++
      else tally.ajaib++
      if (source === Source.both) tally.covered++
      const number = chunk * CHUNK + slot + 1
      if (number > tally.next && tally.next <= tally.limit)
        tally.missing.push([tally.next, Math.min(number - 1, tally.limit)])
      tally.next = number + 1
    }
  })

// Nothing to compare when Ajaib supplied nothing; compared once Stockbit's
// walk ended; pending at its position until then.
const crossCheckOf = (
  tally: Tally,
  walk: CrossCheckFact,
  differences: number
) =>
  Effect.sync((): CrossCheck => {
    if (tally.ajaib === 0) return { state: "none" }
    if (walk.ended)
      return { state: "compared", covered: tally.covered, differences }
    return {
      state: "pending",
      walkedTo: TradeNumber.make(String(walk.walkedTo)),
    }
  })

// Decision: no broker codes answer is ever cached: the status changes with
// every batch.
const answer = (status: number, text?: string) =>
  Effect.sync(
    () =>
      new Response(text ?? null, {
        status,
        headers: { "Cache-Control": "no-store" },
      })
  )

const json = (text: string) =>
  Effect.sync(
    () =>
      new Response(text, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      })
  )

// Which site supplied a kept trade, as `held` names it.
type HeldSource = "Ajaib" | "Stockbit"

export const makeBrokerCodes = Effect.fnUntraced(function* (options: {
  readonly date: WibDate
  // The trading day's database, its facts table made by the day store.
  readonly sql: Sql
  // A fact the day store holds.
  readonly fact: (key: string) => Effect.Effect<string | undefined>
}) {
  const { sql, fact } = options
  yield* Effect.sync(() => {
    for (const statement of SCHEMA) sql.exec(statement)
  })

  const chunkOf = (chunk: number) =>
    Effect.sync(() => {
      const [row] = sql.exec(
        "SELECT codes FROM broker_code_chunks WHERE chunk = ?",
        chunk
      )
      return row === undefined
        ? new Uint8Array(CHUNK * RECORD)
        : new Uint8Array(row.codes as Uint8Array)
    })

  const crossCheckFact = Effect.map(fact(Fact.crossCheck), (text) =>
    Option.getOrElse(decodeCrossCheck(text), () => ({
      walkedTo: 0,
      ended: false,
    }))
  )

  // The facts a batch changes: N, the highest `end.n` either site sent, and
  // Stockbit's walk position and end.
  const factsOf = Effect.fnUntraced(function* (
    batch: BrokerCodesBatch,
    highest: number
  ) {
    const facts: Array<readonly [string, string]> = []
    if (
      batch.end !== undefined &&
      Number(batch.end.n) > Number((yield* fact(Fact.brokerCodesN)) ?? 0)
    )
      facts.push([Fact.brokerCodesN, batch.end.n])
    if (batch.feed !== "Stockbit") return facts
    const before = yield* crossCheckFact
    const after = {
      walkedTo: Math.max(before.walkedTo, highest),
      ended: before.ended || batch.end !== undefined,
    }
    if (after.walkedTo !== before.walkedTo || after.ended !== before.ended)
      facts.push([Fact.crossCheck, encodeCrossCheck(after)])
    return facts
  })

  const merge = Effect.fnUntraced(function* (batch: BrokerCodesBatch) {
    const merged: Merged = {
      chunks: new Map(),
      differences: new Map(),
      agreed: new Set(),
      facts: [],
    }
    let highest = 0
    for (const [tradeNumber, codes] of batch.rows) {
      const number = Number(tradeNumber)
      highest = Math.max(highest, number)
      const { chunk, at } = yield* placeOf(number)
      const held = merged.chunks.get(chunk) ?? (yield* chunkOf(chunk))
      merged.chunks.set(chunk, held)
      const bytes = yield* bytesOf(codes)
      if (batch.feed === "Ajaib") {
        yield* mergeAjaib(held, at, bytes)
        continue
      }
      const outcome = yield* mergeStockbit(held, at, bytes)
      if (outcome === "agreed") {
        merged.agreed.add(number)
        merged.differences.delete(number)
      } else if (outcome === "differs") {
        merged.agreed.delete(number)
        merged.differences.set(number, [held.slice(at, at + SOURCE), bytes])
      }
    }
    merged.facts.push(...(yield* factsOf(batch, highest)))
    return merged
  })

  const commit = (merged: Merged) =>
    Effect.sync(() =>
      sql.transaction(() => {
        for (const [chunk, codes] of merged.chunks)
          sql.exec(
            "INSERT OR REPLACE INTO broker_code_chunks VALUES (?, ?)",
            chunk,
            codes
          )
        for (const [number, [ajaib, stockbit]] of merged.differences)
          sql.exec(
            "INSERT OR REPLACE INTO cross_check_differences VALUES (?, ?, ?)",
            number,
            ajaib,
            stockbit
          )
        for (const number of merged.agreed)
          sql.exec(
            "DELETE FROM cross_check_differences WHERE number = ?",
            number
          )
        for (const [key, value] of merged.facts)
          sql.exec("INSERT OR REPLACE INTO facts VALUES (?, ?)", key, value)
      })
    )

  // A batch merged into its chunks and written in one transaction, so a
  // failed batch writes nothing and the extension resends it.
  const write = (batch: BrokerCodesBatch) =>
    Effect.flatMap(merge(batch), commit)

  // The kept copy of one trade and the site that supplied it; none when the
  // day holds no codes for it.
  const held = Effect.fnUntraced(function* (tradeNumber: TradeNumber) {
    const { chunk, at } = yield* placeOf(Number(tradeNumber))
    const record = (yield* chunkOf(chunk)).subarray(at, at + RECORD)
    const source = record[SOURCE]
    if (source === 0 || source === undefined)
      return Option.none<{ codes: TradeCodes; source: HeldSource }>()
    return Option.some({
      codes: yield* codesOf(record),
      source:
        source === Source.stockbit ? ("Stockbit" as const) : ("Ajaib" as const),
    })
  })

  // Every chunk into the tally, SCAN_PAGE at a time.
  const scan = Effect.fnUntraced(function* (tally: Tally) {
    let after = -1
    for (;;) {
      const rows = yield* Effect.sync(() =>
        sql.exec(
          "SELECT chunk, codes FROM broker_code_chunks WHERE chunk > ? ORDER BY chunk LIMIT ?",
          after,
          SCAN_PAGE
        )
      )
      for (const row of rows) {
        after = Number(row.chunk)
        yield* tallyChunk(tally, after, row.codes as Uint8Array)
      }
      if (rows.length < SCAN_PAGE) return
    }
  })

  // The day's status, from one scan of its chunks.
  const status = Effect.gen(function* () {
    const storedN = yield* fact(Fact.brokerCodesN)
    const n = storedN === undefined ? undefined : Number(storedN)
    const tally: Tally = {
      next: 1,
      limit: n ?? Number.MAX_SAFE_INTEGER,
      missing: [],
      ajaib: 0,
      stockbit: 0,
      covered: 0,
    }
    yield* scan(tally)
    if (n !== undefined && tally.next <= n) tally.missing.push([tally.next, n])
    const differences = yield* Effect.sync(() =>
      Number(
        sql.exec("SELECT count(*) AS count FROM cross_check_differences")[0]
          ?.count
      )
    )
    const day: BrokerCodesStatus = {
      version: BrokerCodesProtocolVersion,
      day: options.date,
      n: n === undefined ? null : TradeNumber.make(String(n)),
      complete: n !== undefined && tally.missing.length === 0,
      missing: tally.missing.map(([first, last]) => [
        TradeNumber.make(String(first)),
        TradeNumber.make(String(last)),
      ]),
      sources: { ajaib: tally.ajaib, stockbit: tally.stockbit },
      crossCheck: yield* crossCheckOf(
        tally,
        yield* crossCheckFact,
        differences
      ),
    }
    return day
  })

  // A POSTed batch: 200 once it is written, 426 for another version, 400 for
  // one that doesn't decode or names another day.
  const post = Effect.fnUntraced(
    function* (text: string) {
      const batch = yield* decodeBrokerCodesBatch(text)
      if (batch.day !== options.date)
        return yield* answer(400, "Batch of another day")
      yield* write(batch)
      return yield* answer(200)
    },
    Effect.catchTags({
      BrokerCodesVersionMismatch: () => answer(426, "Reload the extension"),
      SchemaError: () => answer(400, "Batch not read"),
    })
  )

  const statusAnswer = Effect.gen(function* () {
    return yield* json(yield* encodeBrokerCodesStatus(yield* status))
  })

  return { post, status: statusAnswer, held }
})
