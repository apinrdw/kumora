// A new day's tape as 1,000-number trade chunks (spec apinrdw/kumora#555,
// "Trade chunks", ticket #571): the tape's second backing (tape.ts), with
// the same reads and writes as its row per trade.
import {
  Board,
  Side,
  StockCode,
  TradeNumber,
  TradeSource,
  type RunningTrade,
  type TapeCursor,
  MINUTE_MS,
  SHARES_PER_LOT,
} from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

import type { Sql } from "./day-store.ts"
import {
  TIME_SKEW_MS,
  minuteFloor,
  minutesSpanning,
  type Tape,
} from "./tape-backing.ts"

// A record: present (1), side, board, a spare byte, the code list index
// (u16), the feeds in order (a nibble each, the feed's index + 1), then time,
// price and lots as float64s, so every field reads back exactly. Side, board
// and feed are their index in the relay's lists, which stay append-only
// (envelope.ts, Side).
// Decision: chunk k holds trades 1000k+1 .. 1000k+1000 as fixed 32-byte
// records placed by number; all zero bytes is a trade the tape lacks. A flush
// rewrites only the chunks it adds trades to: about 4 a minute on a busy day.
// See spec apinrdw/kumora#555, "Trade chunks".
export const TRADE_CHUNK = 1_000
const RECORD = 32
const SIDE = 1
const BOARD = 2
const CODE = 4
const FEEDS = 6
const TIME = 8
const PRICE = 16
const LOTS = 24

const TRADE_CHUNKS_SCHEMA = `CREATE TABLE IF NOT EXISTS trade_chunks (
    chunk INTEGER PRIMARY KEY,
    records BLOB NOT NULL
  )`

// Decision: the day's code list is one fact, a JSON array the records index
// into, appended to in the transaction of the flush that first holds a code:
// a tape read loads it in one row, and a restart finds it beside the chunks
// that use it.
export const TRADE_CODES_FACT = "trade-codes"

// A value's index in a relay list. A value outside it fails the decode, so
// the flush's transaction rolls back rather than storing it as another.
const indexIn = <const L extends ReadonlyArray<string>>(
  list: Schema.Literals<L>
) => {
  const known = Schema.decodeUnknownSync(list)
  return (value: L[number]) => list.literals.indexOf(known(value))
}
const sideIndex = indexIn(Side)
const boardIndex = indexIn(Board)
const feedIndex = indexIn(TradeSource)

// Trades read a page of chunks per statement, so a full day's 48 MB of
// chunks never sits in memory at once.
const PAGE = 64

const chunkOf = (number: number) => Math.floor((number - 1) / TRADE_CHUNK)

// The fields a record holds, its code as the code list's index.
export interface TradeRecord {
  readonly time: number
  readonly code: number
  readonly price: number
  readonly lots: number
  readonly side: RunningTrade["side"]
  readonly board: RunningTrade["board"]
  readonly feeds: RunningTrade["feeds"]
}

// An empty chunk's records.
export const emptyRecords = () => new Uint8Array(TRADE_CHUNK * RECORD)

// `record` into slot `slot` of a chunk's records.
export const putRecord = (
  records: Uint8Array,
  slot: number,
  record: TradeRecord
) => {
  const view = new DataView(records.buffer, records.byteOffset + slot * RECORD)
  view.setUint8(0, 1)
  view.setUint8(SIDE, sideIndex(record.side))
  view.setUint8(BOARD, boardIndex(record.board))
  view.setUint16(CODE, record.code, true)
  let feeds = 0
  record.feeds.slice(0, 4).forEach((feed, at) => {
    feeds |= (feedIndex(feed) + 1) << (at * 4)
  })
  view.setUint16(FEEDS, feeds, true)
  view.setFloat64(TIME, record.time, true)
  view.setFloat64(PRICE, record.price, true)
  view.setFloat64(LOTS, record.lots, true)
}

// One stored chunk, read field by field from its records.
// Decision: no chunk buffer outlives its chunk's step. A scan decodes or
// reduces each held trade to plain values before it reads the next chunk,
// and a write stores each chunk before it reads the next, so a sparse tape's
// 10,000 trades never hold 10,000 32 KB chunks. See PR apinrdw/kumora#574.
const chunkReader = (chunk: number, records: Uint8Array) => {
  const view = new DataView(records.buffer, records.byteOffset)
  const at = (slot: number) => slot * RECORD
  const held = (slot: number) => records[at(slot)] === 1
  return {
    chunk,
    records,
    held,
    number: (slot: number) => chunk * TRADE_CHUNK + slot + 1,
    time: (slot: number) => view.getFloat64(at(slot) + TIME, true),
    code: (slot: number) => view.getUint16(at(slot) + CODE, true),
    price: (slot: number) => view.getFloat64(at(slot) + PRICE, true),
    lots: (slot: number) => view.getFloat64(at(slot) + LOTS, true),
    side: (slot: number) => Side.literals[view.getUint8(at(slot) + SIDE)]!,
    board: (slot: number) => Board.literals[view.getUint8(at(slot) + BOARD)]!,
    feeds: (slot: number) => {
      const feeds: Array<RunningTrade["feeds"][number]> = []
      for (
        let packed = view.getUint16(at(slot) + FEEDS, true);
        packed > 0;
        packed >>= 4
      )
        feeds.push(TradeSource.literals[(packed & 15) - 1]!)
      return feeds
    },
    // The held slots, ascending.
    slots: function* () {
      for (let slot = 0; slot < TRADE_CHUNK; slot++) if (held(slot)) yield slot
    },
    // Its last held trade's number at or before `time`, if any.
    numberThrough: (time: number) => {
      let through: number | undefined
      for (let slot = 0; slot < TRADE_CHUNK; slot++)
        if (held(slot) && view.getFloat64(at(slot) + TIME, true) <= time)
          through = chunk * TRADE_CHUNK + slot + 1
      return through
    },
    lastSlot: () => {
      for (let slot = TRADE_CHUNK - 1; slot >= 0; slot--)
        if (held(slot)) return slot
      return 0
    },
  }
}
type Chunk = ReturnType<typeof chunkReader>
// A held trade during its chunk's step: the chunk and its slot there.
type Held = readonly [Chunk, number]

const chunkOfRow = (row: Record<string, unknown>) =>
  chunkReader(Number(row.chunk), new Uint8Array(row.records as Uint8Array))

// Decision: the plain methods run inside a synchronous transaction, and a
// scan in one synchronous step (tape-backing.ts, Tape), so their helpers stay
// plain: `chunkOf`, `emptyRecords`, `indexIn`'s lookups, `putRecord`,
// `chunkReader`, `chunkOfRow`, `loadCodes`, `codeAt`, `stored`,
// `chunksBetween`, `nearest`, `highest`, `eachHeld` and `tradeOf`.
export const makeChunkTape = (sql: Sql): Tape => {
  sql.exec(TRADE_CHUNKS_SCHEMA)

  // The code list, loaded when a record indexes past what is held.
  let codes: ReadonlyArray<string> = []
  const loadCodes = () => {
    const [row] = sql.exec(
      "SELECT value FROM facts WHERE key = ?",
      TRADE_CODES_FACT
    )
    codes =
      row === undefined ? [] : (JSON.parse(String(row.value)) as Array<string>)
  }
  const codeAt = (index: number) => {
    if (index >= codes.length) loadCodes()
    return StockCode.make(codes[index] ?? "")
  }

  const stored = (chunk: number) => {
    const [row] = sql.exec(
      "SELECT chunk, records FROM trade_chunks WHERE chunk = ?",
      chunk
    )
    return row === undefined ? undefined : chunkOfRow(row)
  }

  // The chunks first..last held, ascending, a page per statement.
  const chunksBetween = function* (first: number, last: number) {
    for (let next = first; next <= last;) {
      const rows = sql.exec(
        "SELECT chunk, records FROM trade_chunks WHERE chunk BETWEEN ? AND ? ORDER BY chunk LIMIT ?",
        next,
        last,
        PAGE
      )
      for (const row of rows) yield chunkOfRow(row)
      const end = rows.at(-1)
      if (end === undefined || rows.length < PAGE) return
      next = Number(end.chunk) + 1
    }
  }

  // The nearest chunk held at or above `chunk` (`above`), or at or below it.
  const nearest = (chunk: number, direction: "above" | "below") => {
    const [row] = sql.exec(
      direction === "above"
        ? "SELECT chunk, records FROM trade_chunks WHERE chunk >= ? ORDER BY chunk LIMIT 1"
        : "SELECT chunk, records FROM trade_chunks WHERE chunk <= ? ORDER BY chunk DESC LIMIT 1",
      chunk
    )
    return row === undefined ? undefined : chunkOfRow(row)
  }
  const lowest = Effect.sync(() => nearest(0, "above"))
  const highest = () => nearest(Number.MAX_SAFE_INTEGER, "below")

  // The time of a chunk's first held trade.
  const firstTime = (chunk: Chunk) =>
    Effect.sync(() => chunk.time(chunk.slots().next().value!))

  const tradeOf = ([chunk, slot]: Held): RunningTrade => ({
    tradeNumber: TradeNumber.make(String(chunk.number(slot))),
    time: DateTime.makeUnsafe(chunk.time(slot)),
    code: codeAt(chunk.code(slot)),
    price: chunk.price(slot),
    lots: chunk.lots(slot),
    side: chunk.side(slot),
    board: chunk.board(slot),
    feeds: chunk.feeds(slot),
  })

  // Each held trade from `low` to `high`, ascending, as its chunk and slot.
  const eachHeld = function* (low: number, high: number) {
    for (const chunk of chunksBetween(chunkOf(low), chunkOf(high)))
      for (const slot of chunk.slots()) {
        const number = chunk.number(slot)
        if (number >= low && number <= high) yield [chunk, slot] as Held
      }
  }

  // The trades inside a transaction, a chunk at a time. A number is
  // written once: a copy can't replace it, and a chunk none of the trades
  // lands in isn't rewritten.
  const write = (trades: ReadonlyArray<RunningTrade>) => {
    if (trades.length === 0) return
    loadCodes()
    const list = [...codes]
    const indexes = new Map(list.map((code, index) => [code, index]))
    const indexOf = (code: StockCode) => {
      const known = indexes.get(code)
      if (known !== undefined) return known
      indexes.set(code, list.length)
      return list.push(code) - 1
    }
    const landing = new Map<number, Array<RunningTrade>>()
    for (const trade of trades) {
      const chunk = chunkOf(Number(trade.tradeNumber))
      const into = landing.get(chunk)
      if (into === undefined) landing.set(chunk, [trade])
      else into.push(trade)
    }
    for (const [chunk, into] of landing) {
      const records = stored(chunk)?.records ?? emptyRecords()
      let changed = false
      for (const trade of into) {
        const slot = (Number(trade.tradeNumber) - 1) % TRADE_CHUNK
        if (records[slot * RECORD] === 1) continue
        putRecord(records, slot, {
          time: DateTime.toEpochMillis(trade.time),
          code: indexOf(trade.code),
          price: trade.price,
          lots: trade.lots,
          side: trade.side,
          board: trade.board,
          feeds: trade.feeds,
        })
        changed = true
      }
      if (changed)
        sql.exec(
          "INSERT OR REPLACE INTO trade_chunks VALUES (?, ?)",
          chunk,
          records
        )
    }
    if (list.length > codes.length) {
      sql.exec(
        "INSERT OR REPLACE INTO facts VALUES (?, ?)",
        TRADE_CODES_FACT,
        JSON.stringify(list)
      )
      codes = list
    }
  }

  const highestNumber = () => {
    const chunk = highest()
    return chunk === undefined ? undefined : chunk.number(chunk.lastSlot())
  }

  const numbersBetween = (low: number, high: number) =>
    Array.from(eachHeld(low, high), ([chunk, slot]) => chunk.number(slot))

  // Each stored candle's buy and sell value from the chunks, as tape.ts's
  // REBUILD_CANDLE_SIDES works them out from trade rows.
  const rebuildCandleSides = () => {
    const sides = new Map<string, { buy: number; sell: number }>()
    for (const [chunk, slot] of eachHeld(1, Number.MAX_SAFE_INTEGER)) {
      if (chunk.board(slot) !== "RG") continue
      const minute = chunk.time(slot) - (chunk.time(slot) % MINUTE_MS)
      const key = `${codeAt(chunk.code(slot))} ${minute}`
      const sum = sides.get(key) ?? { buy: 0, sell: 0 }
      const value = chunk.price(slot) * chunk.lots(slot) * SHARES_PER_LOT
      if (chunk.side(slot) === "buy") sum.buy += value
      if (chunk.side(slot) === "sell") sum.sell += value
      sides.set(key, sum)
    }
    for (const [key, { buy, sell }] of sides) {
      const [code, minute] = key.split(" ")
      sql.exec(
        "UPDATE candles SET buy_value = ?, sell_value = ? WHERE code = ? AND minute = ?",
        buy,
        sell,
        code!,
        Number(minute)
      )
    }
  }

  const has = (tradeNumber: TradeNumber) =>
    Effect.sync(() => {
      const number = Number(tradeNumber)
      return stored(chunkOf(number))?.held((number - 1) % TRADE_CHUNK) ?? false
    })

  // How many trades the day stored so far: one pass over its chunks.
  const count = Effect.sync(() => {
    let held = 0
    for (const _ of eachHeld(1, Number.MAX_SAFE_INTEGER)) held++
    return held
  })

  // The newest `limit` trades at or below `from` and at or before `cutoff`,
  // ascending, read a chunk at a time.
  const tradesDown = (from: number, cutoff: number, limit: number) =>
    Effect.sync(() => {
      const trades: Array<RunningTrade> = []
      for (let next = chunkOf(from); next >= 0 && trades.length < limit;) {
        const chunk = nearest(next, "below")
        if (chunk === undefined) break
        for (let slot = TRADE_CHUNK - 1; slot >= 0; slot--) {
          if (trades.length >= limit) break
          if (
            chunk.held(slot) &&
            chunk.number(slot) <= from &&
            chunk.time(slot) <= cutoff
          )
            trades.push(tradeOf([chunk, slot]))
        }
        next = chunk.chunk - 1
      }
      return trades.reverse()
    })

  // The newest `limit` trades, ascending.
  const newest = (limit: number) =>
    tradesDown(Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, limit)

  // Within the chunk the search lands on, the bound is its highest trade at
  // or before the target; every later chunk starts after it.
  // Decision: the trades up to an instant are bounded by a binary search on
  // the chunks by each one's first trade's time, as tape.ts searches rows:
  // IDX hands numbers out in time order. It targets the instant plus
  // TIME_SKEW_MS, and reads about 11 chunk rows on a busy day.
  const highestWithin = Effect.fnUntraced(function* (cutoff: number) {
    const bound = cutoff + TIME_SKEW_MS
    const first = (yield* lowest)?.chunk
    const last = highest()?.chunk
    if (first === undefined || last === undefined) return undefined
    let low = first
    let high = last
    let within: number | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const chunk = nearest(middle, "above")
      if (chunk === undefined || chunk.chunk > high) {
        high = middle - 1
        continue
      }
      if ((yield* firstTime(chunk)) <= bound) {
        within = chunk.numberThrough(bound)
        low = chunk.chunk + 1
      } else high = middle - 1
    }
    return within
  })

  // The newest `limit` trades at or before `at`, below `before` when it is
  // given, ascending.
  const tradesAt = Effect.fnUntraced(function* (
    { at, before }: TapeCursor,
    limit: number
  ) {
    const cutoff = DateTime.toEpochMillis(at)
    const found = yield* highestWithin(cutoff)
    if (found === undefined) return []
    const from =
      before === undefined ? found : Math.min(found, Number(before) - 1)
    return yield* tradesDown(from, cutoff, limit)
  })

  // The trades after `after` and at or before `through`, ascending, from a
  // search two skews before `after`, as tape.ts's.
  const tradesBetween = Effect.fnUntraced(function* (
    after: DateTime.Utc,
    through: DateTime.Utc
  ) {
    const from = DateTime.toEpochMillis(after)
    const to = DateTime.toEpochMillis(through)
    const last = yield* highestWithin(to)
    if (last === undefined) return []
    const first = (yield* highestWithin(from - 2 * TIME_SKEW_MS)) ?? 0
    return yield* Effect.sync(() => {
      const trades: Array<RunningTrade> = []
      for (const held of eachHeld(first + 1, last)) {
        const time = held[0].time(held[1])
        if (time > from && time <= to) trades.push(tradeOf(held))
      }
      return trades
    })
  })

  // The first and last minute that can hold a stored trade, widened by
  // TIME_SKEW_MS as tape.ts's; none when the day stored none.
  const minuteSpan = Effect.gen(function* () {
    const first = yield* lowest
    const last = highest()
    if (first === undefined || last === undefined) return undefined
    return {
      first: yield* minuteFloor((yield* firstTime(first)) - TIME_SKEW_MS),
      last: yield* minuteFloor(last.time(last.lastSlot()) + TIME_SKEW_MS),
    }
  })

  // The minutes the stored trades numbered `first` to `last` fall in,
  // ascending; none when it holds none of them.
  const minutesOf = Effect.fnUntraced(function* (
    first: TradeNumber,
    last: TradeNumber
  ) {
    let earliest = Number.POSITIVE_INFINITY
    let latest = Number.NEGATIVE_INFINITY
    for (const [chunk, slot] of eachHeld(Number(first), Number(last))) {
      earliest = Math.min(earliest, chunk.time(slot))
      latest = Math.max(latest, chunk.time(slot))
    }
    return yield* minutesSpanning(earliest, latest)
  })

  // The numbers from `low` to `high` the tape lacks, marked 1 in `marks`
  // from `low`.
  const markLacking = (low: number, high: number, marks: Uint8Array) =>
    Effect.sync(() => {
      const taped = new Uint8Array(high - low + 1)
      for (const [chunk, slot] of eachHeld(low, high))
        taped[chunk.number(slot) - low] = 1
      for (let at = 0; at < taped.length; at++)
        if (taped[at] === 0) marks[at] = 1
    })

  // The fields of the trades held from `low` to `high`, ascending.
  const fieldsBetween = (low: number, high: number) =>
    Effect.sync(() =>
      Array.from(eachHeld(low, high), ([chunk, slot]) => ({
        number: chunk.number(slot),
        code: codeAt(chunk.code(slot)),
        price: chunk.price(slot),
        lots: chunk.lots(slot),
        board: chunk.board(slot),
      }))
    )

  return {
    shape: "chunks",
    write,
    highestNumber,
    numbersBetween,
    rebuildCandleSides,
    has,
    count,
    newest,
    tradesAt,
    tradesBetween,
    minuteSpan,
    minutesOf,
    markLacking,
    fieldsBetween,
  }
}
