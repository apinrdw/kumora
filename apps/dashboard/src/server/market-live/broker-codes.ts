// A trading day's broker codes (spec apinrdw/kumora#244, "Dashboard:
// TradingDay's broker codes store"): the one kept copy of each trade's broker
// codes and investor types, the day's N, and the cross-check of Ajaib's copy
// against Stockbit's. It lives in the trading-day object's database beside
// the day store, in tables no recorded day answer reads.
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  MISSING_RANGES,
  TradeNumber,
  brokerCodesAfter,
  decodeBrokerCodesBatch,
  encodeBrokerCodesStatus,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type CrossCheck,
  type Feed,
  type TradeCodes,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { BROKER_TRADES_BUILT, Fact, type Sql } from "./day-store.ts"

// Decision: chunk k holds trades 1000k+1 .. 1000k+1000 as 1,000 fixed 7-byte
// records: buyer code, buyer type, seller code, seller type, and the source.
// All zero bytes is an absent trade. A batch rewrites only the chunks it
// touches: 1–2 per Stockbit batch, up to 6 per Ajaib batch of 5,000.
const CHUNK = 1_000
const RECORD = 7
const SOURCE = 6

// Decision: the source byte is `A` for Ajaib's, `S` for Stockbit's, and `B`
// for Ajaib's that Stockbit's copy agreed with: the cross-check's covered
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
  // Decision: the broker trades index, one row per side of each trade the
  // chunks keep codes for, derived from them, so a whole day filters by
  // broker as a key lookup in Data Studio. WITHOUT ROWID makes the primary
  // key the only B-tree, one row write a side. It holds the kept copy's codes
  // only: the source and the cross-check stay in the chunks and
  // `cross_check_differences`. See spec apinrdw/kumora#335.
  `CREATE TABLE IF NOT EXISTS broker_trades (
    broker TEXT NOT NULL,
    investor_type TEXT NOT NULL,
    side TEXT NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (broker, investor_type, side, number)
  ) WITHOUT ROWID`,
]

// Decision: the status reads the chunks this many at a time, so a 1.5M-trade
// day's ~10 MB of records never sits in memory at once.
const SCAN_PAGE = 64

// Stockbit's walk position and whether it ended, kept as the `cross-check`
// fact. `walkedTo` is the highest trade number Stockbit sent.
const CrossCheckFact = Schema.fromJsonString(
  Schema.Struct({ walkedTo: TradeNumber, ended: Schema.Boolean })
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

// An Ajaib row replaces what is held. Against Stockbit's copy, the one held
// or the one a difference recorded, it says whether the two agree, so a day
// Stockbit walked first is compared too, and so is a replaced Ajaib copy.
const mergeAjaib = Effect.fnUntraced(function* (
  held: Uint8Array,
  at: number,
  codes: Uint8Array,
  recorded: Option.Option<Uint8Array>
) {
  const source = held[at + SOURCE]
  const stockbit =
    source === Source.stockbit || source === Source.both
      ? Option.some(held.slice(at, at + SOURCE))
      : recorded
  held.set(codes, at)
  if (Option.isNone(stockbit)) {
    held[at + SOURCE] = Source.ajaib
    return "kept" as const
  }
  const agrees = yield* sameCodes(stockbit.value, 0, codes)
  held[at + SOURCE] = agrees ? Source.both : Source.ajaib
  return agrees ? ("agreed" as const) : ([codes, stockbit.value] as const)
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
  return agrees
    ? ("agreed" as const)
    : ([held.slice(at, at + SOURCE), codes] as const)
})

// One index row: broker, investor type, side and trade number.
type IndexRow = readonly [string, string, "buy" | "sell", number]

// Whether two records hold the same three bytes of the side at `at`.
const sameSide = (held: Uint8Array, codes: Uint8Array, at: number) =>
  held[at] === codes[at] &&
  held[at + 1] === codes[at + 1] &&
  held[at + 2] === codes[at + 2]

// The sides of a record's first six bytes: the buyer's three, then the
// seller's.
const SIDES = [
  ["buy", 0],
  ["sell", 3],
] as const

// One side's index row of a trade, from its record's first six bytes.
const sideRow = (
  number: number,
  record: Uint8Array,
  [side, at]: (typeof SIDES)[number]
): IndexRow => [
  decoder.decode(record.subarray(at, at + 2)),
  record[at + 2] === 70 ? "F" : "D",
  side,
  number,
]

// What a batch writes, in one transaction.
interface Merged {
  readonly chunks: Map<number, Uint8Array>
  // Each trade the batch touched: its codes before the batch, none when the
  // day held none.
  readonly before: Map<number, Option.Option<Uint8Array>>
  // The index rows of trades whose codes the batch changed.
  readonly unindexed: Array<IndexRow>
  readonly indexed: Array<IndexRow>
  readonly differences: Map<number, readonly [Uint8Array, Uint8Array]>
  readonly agreed: Set<number>
  readonly facts: Array<readonly [string, string]>
}

// What the status scan has counted so far.
interface Tally {
  // The lowest number not yet accounted for.
  next: number
  readonly limit: number
  // The highest number the listed ranges start after.
  readonly after: number
  // At most MISSING_RANGES, so a fragmented day holds no more in memory.
  readonly missing: Array<readonly [number, number]>
  missingCount: number
  ajaib: number
  stockbit: number
  covered: number
}

// The missing run first..last into the tally: counted, and listed past
// `after` while the list has room.
const tallyGap = (tally: Tally, first: number, last: number) =>
  Effect.sync(() => {
    tally.missingCount += last - first + 1
    if (last > tally.after && tally.missing.length < MISSING_RANGES)
      tally.missing.push([Math.max(first, tally.after + 1), last])
  })

// One chunk's records into the tally, in trade number order.
const tallyChunk = Effect.fnUntraced(function* (
  tally: Tally,
  chunk: number,
  codes: Uint8Array
) {
  for (let slot = 0; slot < CHUNK; slot++) {
    const source = codes[slot * RECORD + SOURCE]
    if (source === 0 || source === undefined) continue
    if (source === Source.stockbit) tally.stockbit++
    else tally.ajaib++
    if (source === Source.both) tally.covered++
    const number = chunk * CHUNK + slot + 1
    if (number > tally.next && tally.next <= tally.limit)
      yield* tallyGap(tally, tally.next, Math.min(number - 1, tally.limit))
    tally.next = number + 1
  }
})

// Nothing to compare when Ajaib supplied nothing; compared once Stockbit's
// walk ended; pending at its position until then.
// Decision: covered and differences count only trades both sites sent, in
// whichever order they came, so a day Stockbit ended before Ajaib's walk
// reads compared at once and needs no second Stockbit walk. A replaced
// Ajaib copy is compared again against the Stockbit copy its difference
// recorded.
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
      walkedTo: walk.walkedTo,
    }
  })

// Decision: no status or batch answer is cached: the status changes with
// every batch. The route (broker-codes-route.ts) answers through this too. A
// recorded day's codes answer is not one of these: see COMPLETE_CODES_CACHE
// in recorded-answers.ts.
export const noStoreAnswer = (
  status: number,
  text?: string,
  headers: Record<string, string> = {}
) =>
  Effect.sync(
    () =>
      new Response(text ?? null, {
        status,
        headers: { "Cache-Control": "no-store", ...headers },
      })
  )

// A POSTed batch of `day`, or the answer that refuses it: 426 for another
// version, 400 for one that doesn't decode or names another day. The route
// checks a batch before it reaches the object, and the object again, since
// it takes its own input.
export const checkedBatch = (
  text: string,
  day: WibDate
): Effect.Effect<BrokerCodesBatch | Response> =>
  decodeBrokerCodesBatch(text).pipe(
    Effect.flatMap((batch): Effect.Effect<BrokerCodesBatch | Response> =>
      batch.day === day
        ? Effect.succeed(batch)
        : noStoreAnswer(400, "Batch of another day")
    ),
    Effect.catchTags({
      BrokerCodesVersionMismatch: () =>
        noStoreAnswer(426, "Reload the extension"),
      SchemaError: () => noStoreAnswer(400, "Batch not read"),
    })
  )

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
    Option.getOrElse(decodeCrossCheck(text), (): CrossCheckFact => ({
      walkedTo: TradeNumber.make("0"),
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
    const after: CrossCheckFact = {
      walkedTo:
        Number(before.walkedTo) >= highest
          ? before.walkedTo
          : TradeNumber.make(String(highest)),
      ended: before.ended || batch.end !== undefined,
    }
    if (after.walkedTo !== before.walkedTo || after.ended !== before.ended)
      facts.push([Fact.crossCheck, encodeCrossCheck(after)])
    return facts
  })

  // The Stockbit copies that a chunk's differences recorded.
  const recordedOf = (chunk: number) =>
    Effect.sync(() => {
      const recorded = new Map<number, Uint8Array>()
      for (const row of sql.exec(
        "SELECT number, stockbit FROM cross_check_differences WHERE number BETWEEN ? AND ?",
        chunk * CHUNK + 1,
        (chunk + 1) * CHUNK
      ))
        recorded.set(
          Number(row.number),
          new Uint8Array(row.stockbit as Uint8Array)
        )
      return recorded
    })

  // Decision: a batch moves only the index rows of the trade sides whose
  // codes it changed, in the same transaction as their chunks, so the index
  // never disagrees with them after a failure and an unchanged side costs no
  // row write. A Stockbit agreement (source `A` to `B`) or a resent batch
  // changes no codes and writes no index row.
  const indexMoves = Effect.fnUntraced(function* (merged: Merged) {
    for (const [number, before] of merged.before) {
      const { chunk, at } = yield* placeOf(number)
      const after = merged.chunks.get(chunk)!.subarray(at, at + SOURCE)
      const held = Option.getOrUndefined(before)
      for (const side of SIDES) {
        if (held !== undefined && sameSide(held, after, side[1])) continue
        if (held !== undefined)
          merged.unindexed.push(sideRow(number, held, side))
        merged.indexed.push(sideRow(number, after, side))
      }
    }
  })

  const merge = Effect.fnUntraced(function* (batch: BrokerCodesBatch) {
    const merged: Merged = {
      chunks: new Map(),
      before: new Map(),
      unindexed: [],
      indexed: [],
      differences: new Map(),
      agreed: new Set(),
      facts: [],
    }
    const recorded = new Map<number, Map<number, Uint8Array>>()
    // Stockbit's copy of a trade Ajaib's held copy differs on: this batch's
    // difference, else the stored one this batch hasn't cleared.
    const stockbitOf = Effect.fnUntraced(function* (
      number: number,
      chunk: number
    ) {
      const batched = merged.differences.get(number)
      if (batched !== undefined) return Option.some(batched[1])
      if (merged.agreed.has(number)) return Option.none<Uint8Array>()
      const stored = recorded.get(chunk) ?? (yield* recordedOf(chunk))
      recorded.set(chunk, stored)
      return Option.fromNullishOr(stored.get(number))
    })
    let highest = 0
    for (const [tradeNumber, codes] of batch.rows) {
      const number = Number(tradeNumber)
      highest = Math.max(highest, number)
      const { chunk, at } = yield* placeOf(number)
      const held = merged.chunks.get(chunk) ?? (yield* chunkOf(chunk))
      merged.chunks.set(chunk, held)
      const bytes = yield* bytesOf(codes)
      if (!merged.before.has(number))
        merged.before.set(
          number,
          held[at + SOURCE] === 0
            ? Option.none()
            : Option.some(held.slice(at, at + SOURCE))
        )
      const outcome =
        batch.feed === "Ajaib"
          ? yield* mergeAjaib(held, at, bytes, yield* stockbitOf(number, chunk))
          : yield* mergeStockbit(held, at, bytes)
      if (outcome === "agreed") {
        merged.agreed.add(number)
        merged.differences.delete(number)
      } else if (outcome !== "kept") {
        merged.agreed.delete(number)
        merged.differences.set(number, outcome)
      }
    }
    yield* indexMoves(merged)
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
        for (const row of merged.unindexed)
          sql.exec(
            "DELETE FROM broker_trades WHERE broker = ? AND investor_type = ? AND side = ? AND number = ?",
            ...row
          )
        for (const row of merged.indexed)
          sql.exec(
            "INSERT OR IGNORE INTO broker_trades VALUES (?, ?, ?, ?)",
            ...row
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

  // Decision: the day's `complete`, once a scan found it, is kept until the
  // next batch: the recorded day's codes answer carries it, and Play asks
  // for that answer as often as the tape (TAPE_INTERVAL_MS in
  // apps/dashboard/src/lib/replay.ts), which must not scan every chunk each
  // time.
  let complete: boolean | undefined

  // A batch merged into its chunks and written in one transaction, so a
  // failed batch writes nothing and the extension resends it.
  const write = (batch: BrokerCodesBatch) =>
    Effect.flatMap(merge(batch), commit).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          complete = undefined
        })
      )
    )

  // One trade's record, its chunk read once into `chunks`; none when the day
  // holds no codes for it.
  const recordOf = Effect.fnUntraced(function* (
    tradeNumber: TradeNumber,
    chunks: Map<number, Uint8Array>
  ) {
    const { chunk, at } = yield* placeOf(Number(tradeNumber))
    const codes = chunks.get(chunk) ?? (yield* chunkOf(chunk))
    chunks.set(chunk, codes)
    const record = codes.subarray(at, at + RECORD)
    const source = record[SOURCE]
    return source === 0 || source === undefined
      ? Option.none<Uint8Array>()
      : Option.some(record)
  })

  // The kept copy of one trade and the site that supplied it; none when the
  // day holds no codes for it.
  const held = Effect.fnUntraced(function* (tradeNumber: TradeNumber) {
    const record = yield* recordOf(tradeNumber, new Map())
    if (Option.isNone(record))
      return Option.none<{ codes: TradeCodes; source: Feed }>()
    return Option.some({
      codes: yield* codesOf(record.value),
      source:
        record.value[SOURCE] === Source.stockbit
          ? ("Stockbit" as const)
          : ("Ajaib" as const),
    })
  })

  // The kept codes of each listed trade the day holds codes for, in the
  // list's order, reading each chunk the list touches once.
  const heldCodes = Effect.fnUntraced(function* (
    tradeNumbers: ReadonlyArray<TradeNumber>
  ) {
    const chunks = new Map<number, Uint8Array>()
    const found: Array<readonly [TradeNumber, TradeCodes]> = []
    for (const tradeNumber of tradeNumbers) {
      const record = yield* recordOf(tradeNumber, chunks)
      if (Option.isSome(record))
        found.push([tradeNumber, yield* codesOf(record.value)])
    }
    return found
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

  // The day's status, from one scan of its chunks, listing the missing
  // ranges after trade `after`.
  const status = Effect.fnUntraced(function* (after: number) {
    const storedN = yield* fact(Fact.brokerCodesN)
    const n = storedN === undefined ? undefined : Number(storedN)
    const tally: Tally = {
      next: 1,
      limit: n ?? Number.MAX_SAFE_INTEGER,
      after,
      missing: [],
      missingCount: 0,
      ajaib: 0,
      stockbit: 0,
      covered: 0,
    }
    yield* scan(tally)
    if (n !== undefined && tally.next <= n)
      yield* tallyGap(tally, tally.next, n)
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
      complete: n !== undefined && tally.missingCount === 0,
      missing: tally.missing.map(([first, last]) => [
        TradeNumber.make(String(first)),
        TradeNumber.make(String(last)),
      ]),
      missingCount: tally.missingCount,
      sources: { ajaib: tally.ajaib, stockbit: tally.stockbit },
      crossCheck: yield* crossCheckOf(
        tally,
        yield* crossCheckFact,
        differences
      ),
    }
    complete = day.complete
    return day
  })

  // Whether the day's status is complete, scanning only when no scan since
  // the last batch found it.
  const isComplete = Effect.suspend(() =>
    complete === undefined
      ? Effect.map(status(Number.MAX_SAFE_INTEGER), (day) => day.complete)
      : Effect.succeed(complete)
  )

  // A POSTed batch: 200 once it is written, else as `checkedBatch` refuses
  // it.
  const post = Effect.fnUntraced(function* (text: string) {
    const batch = yield* checkedBatch(text, options.date)
    if (batch instanceof Response) return batch
    yield* write(batch)
    return yield* noStoreAnswer(200)
  })

  // A status GET's answer: 400 when its `after` isn't a trade number.
  const statusAnswer = Effect.fnUntraced(function* (search: URLSearchParams) {
    const after = yield* brokerCodesAfter(search)
    if (Option.isNone(after)) return yield* noStoreAnswer(400, "Bad after")
    return yield* noStoreAnswer(
      200,
      yield* encodeBrokerCodesStatus(yield* status(after.value)),
      { "Content-Type": "application/json" }
    )
  })

  // Decision: a day whose codes were stored before the index rebuilds it from
  // its chunks, SCAN_PAGE chunks a call, each page's rows and its progress in
  // one transaction, so a rebuild cut off resumes from the next page. A page
  // only inserts: a batch since the release moved the rows of the trades it
  // changed, so an unrebuilt chunk's rows are already a subset of its
  // derived rows, and a page rerun writes the same rows. A day with no
  // chunks at its object's start indexes every batch live, so it is built
  // from the start. See spec apinrdw/kumora#335.
  const indexBuilt = yield* Effect.gen(function* () {
    const progress = yield* fact(Fact.brokerTrades)
    if (progress === BROKER_TRADES_BUILT) return true
    if (progress !== undefined) return false
    if (sql.exec("SELECT 1 FROM broker_code_chunks LIMIT 1").length > 0)
      return false
    sql.exec(
      "INSERT OR REPLACE INTO facts VALUES (?, ?)",
      Fact.brokerTrades,
      BROKER_TRADES_BUILT
    )
    return true
  })

  // The next page of the index's rebuild; whether the index is built after
  // it.
  const indexPage = Effect.gen(function* () {
    const progress = yield* fact(Fact.brokerTrades)
    if (progress === BROKER_TRADES_BUILT) return true
    const rows = sql.exec(
      "SELECT chunk, codes FROM broker_code_chunks WHERE chunk > ? ORDER BY chunk LIMIT ?",
      progress === undefined ? -1 : Number(progress),
      SCAN_PAGE
    )
    const built = rows.length < SCAN_PAGE
    yield* Effect.sync(() =>
      sql.transaction(() => {
        for (const row of rows) {
          const chunk = Number(row.chunk)
          const codes = row.codes as Uint8Array
          for (let slot = 0; slot < CHUNK; slot++) {
            const at = slot * RECORD
            if (codes[at + SOURCE] === 0 || codes[at + SOURCE] === undefined)
              continue
            const record = codes.subarray(at, at + SOURCE)
            for (const side of SIDES)
              sql.exec(
                "INSERT OR IGNORE INTO broker_trades VALUES (?, ?, ?, ?)",
                ...sideRow(chunk * CHUNK + slot + 1, record, side)
              )
          }
        }
        sql.exec(
          "INSERT OR REPLACE INTO facts VALUES (?, ?)",
          Fact.brokerTrades,
          built ? BROKER_TRADES_BUILT : String(rows.at(-1)!.chunk)
        )
      })
    )
    return built
  })

  return {
    post,
    status: statusAnswer,
    held,
    heldCodes,
    isComplete,
    indexBuilt,
    indexPage,
  }
})

export type BrokerCodesStore = Effect.Success<
  ReturnType<typeof makeBrokerCodes>
>
