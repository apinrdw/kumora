// A trading day's broker codes (spec apinrdw/kumora#244, "Dashboard:
// TradingDay's broker codes store"): the one kept copy of each trade's broker
// codes and investor types, the walks' fields of the trades the tape lacks,
// the day's N, and the cross-check of Ajaib's copy against Stockbit's. It
// lives in the trading-day object's database beside the day store, in tables
// no recorded day answer reads.
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  MISSING_RANGES,
  StockCode,
  TradeNumber,
  brokerCodesAfter,
  decodeBrokerCodesBatch,
  encodeBrokerCodesStatus,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type CrossCheck,
  type Feed,
  type RunningTrade,
  type TradeCodes,
  type TradeFields,
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
  // chunks keep codes for, so a whole day filters by broker as a key lookup
  // in Data Studio. WITHOUT ROWID makes the key the only B-tree, one row
  // write a side. The source and the cross-check stay in the chunks. See
  // apinrdw/kumora#342.
  `CREATE TABLE IF NOT EXISTS broker_trades (
    broker TEXT NOT NULL,
    investor_type TEXT NOT NULL,
    side TEXT NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (broker, investor_type, side, number)
  ) WITHOUT ROWID`,
  // Decision: a walk's fields of each trade the tape lacked, the first row
  // kept. On a day the relay recorded they never fill the tape, so its
  // recorded answers don't change; only the build reads them (#425). A walk
  // day's batches fill its tape until its seal, and until then a row here
  // holds none of its trades (`walkRowsHold`). See #437.
  `CREATE TABLE IF NOT EXISTS walk_trades (
    number INTEGER PRIMARY KEY,
    code TEXT NOT NULL,
    price INTEGER NOT NULL,
    lots REAL NOT NULL,
    board TEXT NOT NULL
  )`,
]

// Decision: the status reads the chunks this many at a time, so a 1.5M-trade
// day's ~10 MB of records never sits in memory at once.
const SCAN_PAGE = 64

// Decision: a day builds with at most 1 in this many of its trades 1..N
// missing (0.1%): a few numbers neither broker site lists never stop it,
// and a half-walked day never passes for light trading. See
// apinrdw/kumora#457.
const MISSING_ALLOWANCE = 1_000

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

// A row's fields as walk_trades stores them, in its column order: none for
// a row without fields.
const fieldsRows = (number: number, fields: TradeFields | undefined) =>
  Effect.succeed(
    fields === undefined
      ? []
      : [
          [
            number,
            fields.code,
            fields.price,
            fields.lots,
            fields.board,
          ] as const,
        ]
  )

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
  // The batch's rows' fields, kept for the trades the tape lacks. A row
  // without fields adds none.
  readonly fields: Array<readonly [number, ...Array<string | number>]>
  // The trades whose kept codes the batch changed. A trade whose source
  // byte alone changed, as the cross-check marks it, is not one.
  readonly changed: Array<TradeNumber>
}

// The kept codes of each listed trade the day holds codes for, in the
// list's order.
export type HeldCodes = (
  tradeNumbers: ReadonlyArray<TradeNumber>
) => Effect.Effect<ReadonlyArray<readonly [TradeNumber, TradeCodes]>>

// A trade the day holds codes and fields for.
interface HeldTrade {
  readonly code: StockCode
  readonly price: number
  readonly lots: number
  readonly board: RunningTrade["board"]
  readonly codes: TradeCodes
}

// What else a batch that changed codes writes, worked out from the codes as
// the batch leaves them: `changed` lists the trades whose codes it changed,
// and `heldCodes` reads the codes the batch holds. It writes its own rows
// and `writeCodes`, the batch's, in one transaction.
type Alongside = (
  changed: ReadonlyArray<TradeNumber>,
  heldCodes: HeldCodes,
  writeCodes: () => void
) => Effect.Effect<void>

// What the status scan has counted so far. A trade is held once the day has
// its codes and its fields, from the tape or, when walk rows hold, a walk's
// row.
interface Tally {
  // The lowest number not yet accounted for as held.
  next: number
  // The lowest number not yet accounted for as having codes.
  codesNext: number
  readonly limit: number
  // The highest number the listed ranges start after.
  readonly after: number
  // At most MISSING_RANGES, so a fragmented day holds no more in memory.
  readonly missing: Array<readonly [number, number]>
  missingCount: number
  // The trades of 1..limit without codes, held fields or not.
  codesMissingCount: number
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

// A kept trade's source into the sites' counts.
const tallySource = (tally: Tally, source: number) =>
  Effect.sync(() => {
    if (source === Source.stockbit) tally.stockbit++
    else tally.ajaib++
    if (source === Source.both) tally.covered++
  })

// How many trades from `from` to just below `number` lie within the limit.
const runBefore = (tally: Tally, from: number, number: number) =>
  Effect.succeed(
    number > from && from <= tally.limit
      ? Math.min(number - 1, tally.limit) - from + 1
      : 0
  )

// One chunk's records into the tally, in trade number order. `unfielded`
// marks the trades of the chunk that neither the tape nor a walk row gave
// fields, from `at` on.
const tallyChunk = Effect.fnUntraced(function* (
  tally: Tally,
  chunk: number,
  codes: Uint8Array,
  unfielded: Uint8Array,
  at: number
) {
  for (let slot = 0; slot < CHUNK; slot++) {
    const source = codes[slot * RECORD + SOURCE]
    if (source === 0 || source === undefined) continue
    yield* tallySource(tally, source)
    const number = chunk * CHUNK + slot + 1
    tally.codesMissingCount += yield* runBefore(tally, tally.codesNext, number)
    tally.codesNext = number + 1
    if (unfielded[at + slot] === 1) continue
    if ((yield* runBefore(tally, tally.next, number)) > 0)
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
  // Whether a walk_trades row holds its trade: not on an unsealed day whose
  // tape the walks fill, which holds a trade only once its tape does.
  readonly walkRowsHold: Effect.Effect<boolean>
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
      fields: [],
      changed: [],
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
    for (const [tradeNumber, codes, fields] of batch.rows) {
      const number = Number(tradeNumber)
      highest = Math.max(highest, number)
      merged.fields.push(...(yield* fieldsRows(number, fields)))
      const { chunk, at } = yield* placeOf(number)
      const held = merged.chunks.get(chunk) ?? (yield* chunkOf(chunk))
      merged.chunks.set(chunk, held)
      const bytes = yield* bytesOf(codes)
      const before = held.slice(at, at + SOURCE)
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
      if (!(yield* sameCodes(before, 0, held.subarray(at, at + SOURCE))))
        merged.changed.push(tradeNumber)
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

  // Decision: a batch's fields land only for the trades the tape lacks as
  // it is written, in the codes' transaction: one statement over the rows,
  // checked against one range read of the tape's numbers the batch spans.
  // A trade already in walk_trades keeps its first row. Whether it filled
  // any trade's fields.
  const writeFields = (fields: Merged["fields"]) => {
    if (fields.length === 0) return false
    let low = Number.MAX_SAFE_INTEGER
    let high = 0
    for (const [number] of fields) {
      low = Math.min(low, number)
      high = Math.max(high, number)
    }
    const filled = sql.exec(
      `INSERT OR IGNORE INTO walk_trades (number, code, price, lots, board)
      SELECT row.value ->> 0, row.value ->> 1, row.value ->> 2,
        row.value ->> 3, row.value ->> 4
      FROM json_each(?) AS row
      WHERE row.value ->> 0 NOT IN
        (SELECT number FROM trades WHERE number BETWEEN ? AND ?)
      RETURNING number`,
      JSON.stringify(fields),
      low,
      high
    )
    return filled.length > 0
  }

  // A batch's writes, to run inside a transaction; `filled` runs when they
  // filled a trade's fields.
  const writesOf = (merged: Merged, filled: () => void) => () => {
    if (writeFields(merged.fields)) filled()
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
      sql.exec("DELETE FROM cross_check_differences WHERE number = ?", number)
    for (const [key, value] of merged.facts)
      sql.exec("INSERT OR REPLACE INTO facts VALUES (?, ?)", key, value)
  }

  // Decision: whether the day has codes for every trade 1..N is kept, once a
  // scan found it, until the next batch: Play asks for the codes answer that
  // carries it as often as the tape (TAPE_INTERVAL_MS in src/lib/replay.ts).
  // It reads no fields, so the tape growing before the seal can't change it;
  // the status's `complete` reads the tape, and each status GET scans again.
  let keptCodesComplete: boolean | undefined

  // A batch merged into its chunks and written in one transaction, with
  // what `alongside` writes for the trades it changed, so a failed batch
  // writes nothing and the extension resends it.
  // Decision: the sweep brokers rows land in the codes' own transaction.
  // Once a batch that changes no codes recomputes nothing, rows written in a
  // later transaction that failed would stay stale for good: the resent
  // batch would change nothing. See spec apinrdw/kumora#343, "When it is
  // recomputed".
  const write = Effect.fnUntraced(function* (
    batch: BrokerCodesBatch,
    alongside: Alongside
  ) {
    const merged = yield* merge(batch)
    let filled = false
    const writeCodes = writesOf(merged, () => {
      filled = true
    })
    if (merged.changed.length === 0)
      yield* Effect.sync(() => sql.transaction(writeCodes))
    else
      yield* alongside(
        merged.changed,
        (tradeNumbers) => heldCodes(tradeNumbers, new Map(merged.chunks)),
        writeCodes
      )
    keptCodesComplete = undefined
    // Whether the batch corrected the day: changed a trade's kept codes,
    // filled its fields, or raised N, which a built day's missing count
    // reads.
    return (
      merged.changed.length > 0 ||
      filled ||
      merged.facts.some(([key]) => key === Fact.brokerCodesN)
    )
  })

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
  // list's order, reading each chunk the list touches once: from `chunks`
  // when it holds it, else from the table.
  const heldCodes = Effect.fnUntraced(function* (
    tradeNumbers: ReadonlyArray<TradeNumber>,
    chunks = new Map<number, Uint8Array>()
  ) {
    const found: Array<readonly [TradeNumber, TradeCodes]> = []
    for (const tradeNumber of tradeNumbers) {
      const record = yield* recordOf(tradeNumber, chunks)
      if (Option.isSome(record))
        found.push([tradeNumber, yield* codesOf(record.value)])
    }
    return found
  })

  // The trades of chunks first..last that neither the tape nor, when
  // `walkRowsHold`, walk_trades holds, marked 1 from the first chunk's first
  // trade. walk_trades holds only trades that were holes, so its numbers are
  // read one by one.
  // Decision: a span the tape holds whole is known from its count; any other
  // reads the runs between the tape's numbers, so no row per taped trade sits
  // in memory. A 1.5M-trade day's status scan took 152 ms in Node's SQLite,
  // against 118 ms for codes alone and 850 ms reading the runs everywhere.
  const unfieldedOf = (first: number, last: number, walkRowsHold: boolean) =>
    Effect.sync(() => {
      const low = first * CHUNK + 1
      const high = (last + 1) * CHUNK
      const unfielded = new Uint8Array(high - low + 1)
      const [taped] = sql.exec(
        "SELECT count(*) AS count FROM trades WHERE number BETWEEN ? AND ?",
        low,
        high
      )
      if (Number(taped?.count) === unfielded.length) return unfielded
      for (const row of sql.exec(
        `SELECT prev + 1 AS first, number - 1 AS last FROM (
          SELECT number, lag(number, 1, ?) OVER (ORDER BY number) AS prev
          FROM trades WHERE number BETWEEN ? AND ?
        ) WHERE number > prev + 1`,
        low - 1,
        low,
        high
      ))
        unfielded.fill(1, Number(row.first) - low, Number(row.last) - low + 1)
      const [tapeHigh] = sql.exec(
        "SELECT max(number) AS number FROM trades WHERE number BETWEEN ? AND ?",
        low,
        high
      )
      unfielded.fill(1, Number(tapeHigh?.number ?? low - 1) - low + 1)
      if (!walkRowsHold) return unfielded
      for (const row of sql.exec(
        "SELECT number FROM walk_trades WHERE number BETWEEN ? AND ?",
        low,
        high
      ))
        unfielded[Number(row.number) - low] = 0
      return unfielded
    })

  // Every chunk into the tally, SCAN_PAGE at a time, each run of adjacent
  // chunks of a page with its unfielded trades.
  const scan = Effect.fnUntraced(function* (tally: Tally) {
    const walkRowsHold = yield* options.walkRowsHold
    let after = -1
    for (;;) {
      const rows = yield* Effect.sync(() =>
        sql.exec(
          "SELECT chunk, codes FROM broker_code_chunks WHERE chunk > ? ORDER BY chunk LIMIT ?",
          after,
          SCAN_PAGE
        )
      )
      for (let start = 0; start < rows.length;) {
        let end = start
        while (
          end + 1 < rows.length &&
          Number(rows[end + 1]!.chunk) === Number(rows[end]!.chunk) + 1
        )
          end++
        const first = Number(rows[start]!.chunk)
        const unfielded = yield* unfieldedOf(
          first,
          Number(rows[end]!.chunk),
          walkRowsHold
        )
        for (let at = start; at <= end; at++) {
          after = Number(rows[at]!.chunk)
          yield* tallyChunk(
            tally,
            after,
            rows[at]!.codes as Uint8Array,
            unfielded,
            (after - first) * CHUNK
          )
        }
        start = end + 1
      }
      if (rows.length < SCAN_PAGE) return
    }
  })

  // The day's status, from one scan of its chunks, listing the missing
  // ranges after trade `after`, and whether it has codes for every trade
  // 1..N, its fields held or not.
  const status = Effect.fnUntraced(function* (after: number) {
    const storedN = yield* fact(Fact.brokerCodesN)
    const n = storedN === undefined ? undefined : Number(storedN)
    const tally: Tally = {
      next: 1,
      codesNext: 1,
      limit: n ?? Number.MAX_SAFE_INTEGER,
      after,
      missing: [],
      missingCount: 0,
      codesMissingCount: 0,
      ajaib: 0,
      stockbit: 0,
      covered: 0,
    }
    yield* scan(tally)
    if (n !== undefined && tally.next <= n)
      yield* tallyGap(tally, tally.next, n)
    if (n !== undefined && tally.codesNext <= n)
      tally.codesMissingCount += n - tally.codesNext + 1
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
    const codesComplete = n !== undefined && tally.codesMissingCount === 0
    keptCodesComplete = codesComplete
    return { day, codesComplete }
  })

  // Whether the day has codes for every trade 1..N, its fields held or not,
  // scanning only when no scan since the last batch found it. Market Live's
  // answers read this, not the status's `complete`.
  const codesComplete = Effect.suspend(() =>
    keptCodesComplete === undefined
      ? Effect.map(
          status(Number.MAX_SAFE_INTEGER),
          (each) => each.codesComplete
        )
      : Effect.succeed(keptCodesComplete)
  )

  // The day's missing count when its broker totals can build, from one
  // scan: N known and at most 1 in MISSING_ALLOWANCE of 1..N missing.
  const buildable = Effect.map(status(Number.MAX_SAFE_INTEGER), ({ day }) =>
    day.n !== null && day.missingCount * MISSING_ALLOWANCE <= Number(day.n)
      ? Option.some(day.missingCount)
      : Option.none<number>()
  )

  // Decision: a held trade's fields are the tape's, else its walk row's: the
  // tape can gain a trade after a walk row was stored for it, and walk rows
  // are never deleted. See apinrdw/kumora#425.
  const FIELDS_BETWEEN = `SELECT number, code, price, lots, board FROM trades
    WHERE number BETWEEN ? AND ?
    UNION ALL
    SELECT number, code, price, lots, board FROM walk_trades
    WHERE number BETWEEN ? AND ?
      AND number NOT IN (SELECT number FROM trades WHERE number BETWEEN ? AND ?)
    ORDER BY number`

  // The trades of the SCAN_PAGE chunks after chunk `after` that the day
  // holds codes and fields for, in trade number order, and the last chunk
  // read; none past the last chunk.
  const heldTradesPage = Effect.fnUntraced(function* (after: number) {
    const rows = yield* Effect.sync(() =>
      sql.exec(
        "SELECT chunk, codes FROM broker_code_chunks WHERE chunk > ? ORDER BY chunk LIMIT ?",
        after,
        SCAN_PAGE
      )
    )
    if (rows.length === 0) return undefined
    const chunks = new Map(
      rows.map((row) => [Number(row.chunk), row.codes as Uint8Array])
    )
    const last = Number(rows.at(-1)!.chunk)
    const span = [Number(rows[0]!.chunk) * CHUNK + 1, (last + 1) * CHUNK]
    const fields = yield* Effect.sync(() =>
      sql.exec(FIELDS_BETWEEN, ...span, ...span, ...span)
    )
    const trades: Array<HeldTrade> = []
    for (const row of fields) {
      const { chunk, at } = yield* placeOf(Number(row.number))
      const record = chunks.get(chunk)?.subarray(at, at + RECORD)
      if (record === undefined || !record[SOURCE]) continue
      trades.push({
        code: StockCode.make(String(row.code)),
        price: Number(row.price),
        lots: Number(row.lots),
        board: String(row.board) as RunningTrade["board"],
        codes: yield* codesOf(record),
      })
    }
    return { trades, last }
  })

  // A POSTed batch: 200 once `taken` took it, it is written with what
  // `alongside` writes for it and `written` has run, else as `checkedBatch`
  // refuses it. `written` runs after every accepted batch, one that changed
  // no codes included, and hears whether the batch corrected the day.
  const post = Effect.fnUntraced(function* (
    text: string,
    hooks: {
      readonly taken: (batch: BrokerCodesBatch) => Effect.Effect<void>
      readonly alongside: Alongside
      readonly written: (corrected: boolean) => Effect.Effect<void>
    }
  ) {
    const batch = yield* checkedBatch(text, options.date)
    if (batch instanceof Response) return batch
    yield* hooks.taken(batch)
    yield* hooks.written(yield* write(batch, hooks.alongside))
    return yield* noStoreAnswer(200)
  })

  // A status GET's answer: 400 when its `after` isn't a trade number.
  const statusAnswer = Effect.fnUntraced(function* (search: URLSearchParams) {
    const after = yield* brokerCodesAfter(search)
    if (Option.isNone(after)) return yield* noStoreAnswer(400, "Bad after")
    return yield* noStoreAnswer(
      200,
      yield* encodeBrokerCodesStatus((yield* status(after.value)).day),
      { "Content-Type": "application/json" }
    )
  })

  // Whether the day holds no trade's codes yet.
  const holdsNone = Effect.sync(
    () => sql.exec("SELECT 1 FROM broker_code_chunks LIMIT 1").length === 0
  )

  // Decision: a day stored before the index rebuilds it SCAN_PAGE chunks a
  // call, rows and progress in one transaction, so a cut-off rebuild resumes.
  // A page only inserts: live batches already moved the rows they changed.
  // A day with no chunks at start is built from the start. See
  // apinrdw/kumora#342.
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
    codesComplete,
    buildable,
    heldTradesPage,
    holdsNone,
    indexBuilt,
    indexPage,
  }
})

export type BrokerCodesStore = Effect.Success<
  ReturnType<typeof makeBrokerCodes>
>
