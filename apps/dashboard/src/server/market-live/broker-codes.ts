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

import {
  Fact,
  TAPE_SUMMARY_BUILT,
  type Sql,
  type SqlValue,
} from "./day-store.ts"

// Decision: chunk k holds trades 1000k+1 .. 1000k+1000 as 1,000 fixed 7-byte
// records: buyer code, buyer type, seller code, seller type, and the source.
// All zero bytes is an absent trade. A batch rewrites only the chunks it
// touches: 1–2 per Stockbit batch, up to 6 per Ajaib batch of 5,000. The
// row budgets' busy day (billing/busy-day.ts) writes its chunks with these.
export const CHUNK = 1_000
export const RECORD = 7
export const SOURCE = 6

// Decision: the source byte is `A` for Ajaib's, `S` for Stockbit's, and `B`
// for Ajaib's that Stockbit's copy agreed with: the cross-check's covered
// trades are counted from it, so a resent Stockbit batch counts none twice.
export const Source = { ajaib: 65, stockbit: 83, both: 66 } as const

// What a day recorded before apinrdw/kumora#561 holds and the store drops
// at its start: the broker trades index, one row per side of each trade, and
// the facts of its rebuild. The row budgets' busy day (billing/busy-day.ts)
// makes them from these, to measure the drop.
export const BROKER_TRADES_INDEX = `CREATE TABLE broker_trades (
    broker TEXT NOT NULL,
    investor_type TEXT NOT NULL,
    side TEXT NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (broker, investor_type, side, number)
  ) WITHOUT ROWID`
export const DroppedFact = {
  brokerTrades: "broker-trades",
  indexWake: "index-wake",
} as const

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
  // Decision: the tape summary, one row per chunk the tape holds a trade of:
  // how many of its numbers the tape holds, and the runs it lacks as JSON
  // [first, last] pairs. A row stands for the tape only once the
  // `tape-summary` fact says so (TAPE_SUMMARY_BUILT). See apinrdw/kumora#543.
  `CREATE TABLE IF NOT EXISTS tape_summary (
    chunk INTEGER PRIMARY KEY,
    taped INTEGER NOT NULL,
    holes TEXT NOT NULL
  )`,
  // Decision: a day recorded before apinrdw/kumora#561 drops its broker
  // trades index, which nothing read, and the facts of its rebuild. In
  // workerd the drop of a busy day's 2.92 M rows read 14 rows and wrote
  // none (row-budgets.workerd.test.ts).
  "DROP TABLE IF EXISTS broker_trades",
  `DELETE FROM facts WHERE key IN ('${DroppedFact.brokerTrades}', '${DroppedFact.indexWake}')`,
]

// Decision: the status reads the chunks this many at a time, so a 1.5M-trade
// day's ~10 MB of records never sits in memory at once.
const SCAN_PAGE = 64

// Decision: a day builds with at most 1 in this many of its trades 1..N
// missing (0.1%): a few numbers neither broker site lists never stop it,
// and a half-walked day never passes for light trading. See
// apinrdw/kumora#457.
export const MISSING_ALLOWANCE = 1_000

// A tape summary row's runs the tape lacks, as [first, last] pairs.
type Holes = ReadonlyArray<readonly [number, number]>

// One chunk's tape summary row, inside a transaction.
const writeSummaryRow = (
  sql: Sql,
  chunk: number,
  taped: number,
  holes: Holes
) =>
  sql.exec(
    "INSERT OR REPLACE INTO tape_summary VALUES (?, ?, ?)",
    chunk,
    taped,
    JSON.stringify(holes)
  )

// The runs a tape summary row's `holes` column holds, as `writeSummaryRow`
// wrote them.
const holesOf = (row: Record<string, SqlValue>) =>
  JSON.parse(String(row.holes)) as Holes

// The summary rows of chunks first..last that hold a tape trade, from one
// read of their trades' numbers, inside a transaction.
// Decision: the runs are worked out here, not in SQL: one statement that
// grouped the tape by chunk over lag() billed 5 rows read a trade in workerd,
// its window's and grouping's temporary tables counted, against 1 here.
const summarizeChunks = (sql: Sql, first: number, last: number) => {
  let chunk = -1
  let taped = 0
  // The lowest number of `chunk` not yet accounted for.
  let next = 0
  let holes: Array<readonly [number, number]> = []
  const written = () => {
    if (chunk < 0) return
    if (next <= (chunk + 1) * CHUNK) holes.push([next, (chunk + 1) * CHUNK])
    writeSummaryRow(sql, chunk, taped, holes)
  }
  for (const row of sql.exec(
    "SELECT number FROM trades WHERE number BETWEEN ? AND ? ORDER BY number",
    first * CHUNK + 1,
    (last + 1) * CHUNK
  )) {
    const number = Number(row.number)
    const at = Math.floor((number - 1) / CHUNK)
    if (at !== chunk) {
      written()
      chunk = at
      taped = 0
      next = at * CHUNK + 1
      holes = []
    }
    if (number > next) holes.push([next, number - 1])
    taped++
    next = number + 1
  }
  written()
}

const summaryBuilt = (sql: Sql) =>
  sql.exec("SELECT value FROM facts WHERE key = ?", Fact.tapeSummary)[0]
    ?.value === TAPE_SUMMARY_BUILT

// The whole tape's summary rows and the fact that they stand for it, inside
// a transaction. It reads SCAN_PAGE chunks' trades at a time, so the whole
// tape's numbers never sit in memory at once.
const summarizeWhole = (sql: Sql) => {
  const [top] = sql.exec("SELECT max(number) AS number FROM trades")
  const chunks = Math.ceil(Number(top?.number ?? 0) / CHUNK)
  for (let first = 0; first < chunks; first += SCAN_PAGE)
    summarizeChunks(sql, first, first + SCAN_PAGE - 1)
  sql.exec(
    "INSERT OR REPLACE INTO facts VALUES (?, ?)",
    Fact.tapeSummary,
    TAPE_SUMMARY_BUILT
  )
}

// Decision: the seal summarizes the tape in its own transaction, after the
// sealed marker: about 1.46 M rows read and 1,460 written on a busy day
// (row-budgets.workerd.test.ts). A seal cut off between them summarizes on
// its retry (`finishSeal`, trading-day.ts), or at a status pass before it
// (`scan`). A tape its walk batches kept summarized isn't again.
export const summarizeTape = (sql: Sql) =>
  Effect.sync(() =>
    sql.transaction(() => {
      if (!summaryBuilt(sql)) summarizeWhole(sql)
    })
  )

// The runs of 1s in `marks`, the marks of chunk `chunk`, as trade numbers.
const runsOf = (chunk: number, marks: Uint8Array) => {
  const runs: Array<readonly [number, number]> = []
  for (let slot = 0; slot < CHUNK; slot++) {
    if (marks[slot] !== 1) continue
    const from = slot
    while (marks[slot + 1] === 1) slot++
    runs.push([chunk * CHUNK + from + 1, chunk * CHUNK + slot + 1])
  }
  return runs
}

// Decision: a walk batch's tape trades leave the holes of their chunks'
// summary rows in the transaction that writes them, so a walk day's status
// reads the summary as a sealed day's does, and a batch reads those rows,
// not the chunks' trades. A tape stored before the summary is summarized
// whole at its first such write. See apinrdw/kumora#543.
export const summarizeAddedTrades =
  (sql: Sql, numbers: ReadonlyArray<number>) => () => {
    if (numbers.length === 0) return
    if (!summaryBuilt(sql)) return summarizeWhole(sql)
    // Each touched chunk's trades the tape lacks, marked 1.
    const lacking = new Map<number, Uint8Array>()
    for (const number of numbers) {
      const chunk = Math.floor((number - 1) / CHUNK)
      let marks = lacking.get(chunk)
      if (marks === undefined) {
        const [row] = sql.exec(
          "SELECT holes FROM tape_summary WHERE chunk = ?",
          chunk
        )
        marks = new Uint8Array(CHUNK)
        if (row === undefined) marks.fill(1)
        else
          for (const [from, to] of holesOf(row))
            marks.fill(1, from - chunk * CHUNK - 1, to - chunk * CHUNK)
        lacking.set(chunk, marks)
      }
      marks[number - chunk * CHUNK - 1] = 0
    }
    for (const [chunk, marks] of lacking) {
      const holes = runsOf(chunk, marks)
      writeSummaryRow(
        sql,
        chunk,
        CHUNK - holes.reduce((count, [from, to]) => count + to - from + 1, 0),
        holes
      )
    }
  }

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
// a row without fields, or when walk_trades `keeps` none.
const fieldsRows = (
  number: number,
  fields: TradeFields | undefined,
  keeps: boolean
) =>
  Effect.succeed(
    fields === undefined || !keeps
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

// What a batch writes, in one transaction.
interface Merged {
  readonly chunks: Map<number, Uint8Array>
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

// Whether a chunk's first `slots` records all hold codes.
const holdsCodes = (codes: Uint8Array, slots: number) => {
  for (let slot = 0; slot < slots; slot++)
    if (!codes[slot * RECORD + SOURCE]) return false
  return true
}

// Whether a merged batch raises the day's N.
const raisesN = (merged: Merged) =>
  merged.facts.some(([key]) => key === Fact.brokerCodesN)

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
  readonly sealed: Effect.Effect<boolean>
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

  const merge = Effect.fnUntraced(function* (batch: BrokerCodesBatch) {
    const merged: Merged = {
      chunks: new Map(),
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
    // Decision: on an unsealed walk or unknown day, `walkTapeOf`
    // (trading-day.ts, on the same condition) took the batch's fields as its
    // tape before the merge, so a walk_trades row would hold nothing. The
    // batch writes none and skips `writeFields`'s check against the tape: 0
    // rows, against 10 K read for a walk day's Ajaib page of 5,000.
    const keepsFields = yield* options.walkRowsHold
    let highest = 0
    for (const [tradeNumber, codes, fields] of batch.rows) {
      const number = Number(tradeNumber)
      highest = Math.max(highest, number)
      merged.fields.push(...(yield* fieldsRows(number, fields, keepsFields)))
      const { chunk, at } = yield* placeOf(number)
      const held = merged.chunks.get(chunk) ?? (yield* chunkOf(chunk))
      merged.chunks.set(chunk, held)
      const bytes = yield* bytesOf(codes)
      const before = held.slice(at, at + SOURCE)
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

  // Whether the day holds codes for every trade 1..N, its fields held or
  // not, read from its chunks SCAN_PAGE at a time until the first trade
  // without codes. Synchronous, so a batch's transaction runs it.
  const codesHeldThroughN = () => {
    const [stored] = sql.exec(
      "SELECT value FROM facts WHERE key = ?",
      Fact.brokerCodesN
    )
    if (stored === undefined) return false
    const n = Number(stored.value)
    const chunks = Math.ceil(n / CHUNK)
    for (let next = 0; next < chunks;) {
      const rows = sql.exec(
        "SELECT chunk, codes FROM broker_code_chunks WHERE chunk >= ? AND chunk < ? ORDER BY chunk LIMIT ?",
        next,
        chunks,
        SCAN_PAGE
      )
      if (rows.length === 0) return false
      for (const row of rows) {
        const slots = Math.min(CHUNK, n - next * CHUNK)
        if (Number(row.chunk) !== next) return false
        if (!holdsCodes(row.codes as Uint8Array, slots)) return false
        next++
      }
    }
    return true
  }

  // The codes-complete fact counted from the chunks and written, and its
  // value.
  const recountCodesComplete = () => {
    const complete = codesHeldThroughN()
    sql.exec(
      "INSERT OR REPLACE INTO facts VALUES (?, ?)",
      Fact.codesComplete,
      String(complete)
    )
    return complete
  }

  // Decision: each batch writes the codes-complete fact in its own
  // transaction, so a woken object answers from one row (spec #554). A batch
  // never clears codes, so on a complete day one that doesn't raise N reads
  // 1 row; else it recounts, up to every chunk, about 1,500 rows on a busy
  // day.
  const recountCodesCompleteIfStale = (nRaised: boolean) => {
    const [kept] = sql.exec(
      "SELECT value FROM facts WHERE key = ?",
      Fact.codesComplete
    )
    if (kept?.value !== "true" || nRaised) recountCodesComplete()
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
    recountCodesCompleteIfStale(raisesN(merged))
  }

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
    // Whether the batch corrected the day: changed a trade's kept codes,
    // filled its fields, or raised N, which a built day's missing count
    // reads.
    return merged.changed.length > 0 || filled || raisesN(merged)
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

  // The trades of chunks first..last the tape lacks, marked 1 in `unfielded`
  // from the first chunk's first trade, read from the tape summary.
  const summaryHoles = (first: number, last: number, unfielded: Uint8Array) =>
    Effect.sync(() => {
      const low = first * CHUNK + 1
      unfielded.fill(1)
      for (const row of sql.exec(
        "SELECT chunk, taped, holes FROM tape_summary WHERE chunk BETWEEN ? AND ?",
        first,
        last
      )) {
        const at = Number(row.chunk) * CHUNK + 1 - low
        unfielded.fill(0, at, at + CHUNK)
        if (Number(row.taped) === CHUNK) continue
        for (const [from, to] of holesOf(row))
          unfielded.fill(1, from - low, to - low + 1)
      }
    })

  // The same, read from the tape itself.
  // Decision: a span the tape holds whole is known from its count; any other
  // reads the runs between the tape's numbers, so no row per taped trade sits
  // in memory. A 1.5M-trade day's status scan took 152 ms in Node's SQLite,
  // against 118 ms for codes alone and 850 ms reading the runs everywhere.
  const tapeHoles = (first: number, last: number, unfielded: Uint8Array) =>
    Effect.sync(() => {
      const low = first * CHUNK + 1
      const high = (last + 1) * CHUNK
      const [taped] = sql.exec(
        "SELECT count(*) AS count FROM trades WHERE number BETWEEN ? AND ?",
        low,
        high
      )
      if (Number(taped?.count) === unfielded.length) return
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
    })

  // The trades of chunks first..last that neither the tape nor, when
  // `walkRowsHold`, walk_trades holds, marked 1 from the first chunk's first
  // trade. walk_trades holds only trades that were holes, so its numbers are
  // read one by one.
  // Decision: a day whose tape summary is built reads it, not the tape: a
  // status pass on a 1.46M-trade sealed day bills about 3 K rows read, the
  // chunks and their summary rows, against 2.7 M counting the tape
  // (row-budgets.workerd.test.ts). See apinrdw/kumora#543.
  const unfieldedOf = (
    first: number,
    last: number,
    reads: { readonly walkRowsHold: boolean; readonly summarized: boolean }
  ) =>
    Effect.gen(function* () {
      const low = first * CHUNK + 1
      const high = (last + 1) * CHUNK
      const unfielded = new Uint8Array(high - low + 1)
      yield* (reads.summarized ? summaryHoles : tapeHoles)(
        first,
        last,
        unfielded
      )
      if (!reads.walkRowsHold) return unfielded
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
  // Decision: a day sealed before the tape summary builds it at its first
  // status pass, one scan of the tape, and later passes read it; there is no
  // migration. A relay day before its seal scans its growing tape.
  const scan = Effect.fnUntraced(function* (tally: Tally) {
    let summarized = (yield* fact(Fact.tapeSummary)) === TAPE_SUMMARY_BUILT
    if (!summarized && (yield* options.sealed)) {
      yield* summarizeTape(sql)
      summarized = true
    }
    const reads = { walkRowsHold: yield* options.walkRowsHold, summarized }
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
          reads
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
  // ranges after trade `after`. Whether the day has codes for every trade
  // is `codesComplete`'s.
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
    return day
  })

  // Whether the day has codes for every trade 1..N, its fields held or not,
  // from its codes-complete fact. Market Live's answers read this, not the
  // status's `complete`. Play asks for the codes answer that carries it as
  // often as the tape (TAPE_INTERVAL_MS in src/lib/replay.ts).
  // Decision: a day whose batches came before the fact existed reads its
  // chunks once and writes the fact, about 1.46 K rows read and 2 written on
  // a busy day, and the next GET reads the fact
  // (row-budgets.workerd.test.ts); a day with no N reads 1 row and writes
  // nothing.
  const codesComplete = Effect.gen(function* () {
    const kept = yield* fact(Fact.codesComplete)
    if (kept !== undefined) return kept === "true"
    if ((yield* fact(Fact.brokerCodesN)) === undefined) return false
    return yield* Effect.sync(recountCodesComplete)
  })

  // The codes-complete fact counted from the day's chunks, not written: the
  // seal writes it with the sealed marker.
  const codesCompleteFactForSeal = Effect.sync(() => ({
    [Fact.codesComplete]: String(codesHeldThroughN()),
  }))

  // The day's missing count when its broker totals can build, from one
  // scan: N known and at most 1 in MISSING_ALLOWANCE of 1..N missing.
  const buildable = Effect.map(status(Number.MAX_SAFE_INTEGER), (day) =>
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
      yield* encodeBrokerCodesStatus(yield* status(after.value)),
      { "Content-Type": "application/json" }
    )
  })

  // Whether the day holds no trade's codes yet.
  const holdsNone = Effect.sync(
    () => sql.exec("SELECT 1 FROM broker_code_chunks LIMIT 1").length === 0
  )

  return {
    post,
    status: statusAnswer,
    held,
    heldCodes,
    codesComplete,
    codesCompleteFactForSeal,
    buildable,
    heldTradesPage,
    holdsNone,
  }
})

export type BrokerCodesStore = Effect.Success<
  ReturnType<typeof makeBrokerCodes>
>
