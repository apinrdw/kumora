// A cold day's tape in R2 (spec apinrdw/kumora#556, "The layout", ticket
// #578): its trades, each with its broker codes, in gzip blocks of 1,000
// behind a small tape index, so a Tape or BrokerCodes answer at any cursor
// reads the index, kept per isolate, and one or two blocks by range.
import { gunzipSync, gzipSync } from "node:zlib"

import {
  RunningTrade,
  TradeCodes,
  TradeNumber,
  encodeRecordedBrokerCodes,
  encodeRecordedTape,
  type TapeCursor,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

import {
  dayKeys,
  putObject,
  sealedAnswer,
  type DayBucket,
  type DayKeys,
} from "./cold-bucket.ts"
import { SNAPSHOT_TRADES } from "./recorded-answers.ts"
import { TIME_SKEW_MS } from "./tape-backing.ts"

// Decision: a cold tape block is 1,000 gzipped trades, stored 10 to an object
// (apps/dashboard/docs/adr/0073-cold-tape-blocks-are-1-000-trades-10-to-an-object.md)
const TAPE_BLOCK = 1_000

// Decision: a cold tape block is 1,000 gzipped trades, stored 10 to an object
// (apps/dashboard/docs/adr/0073-cold-tape-blocks-are-1-000-trades-10-to-an-object.md)
const BLOCKS_PER_SEGMENT = 10

const TapeBlock = Schema.Struct({
  trades: Schema.Array(RunningTrade),
  codes: Schema.Array(Schema.Tuple([TradeNumber, TradeCodes])),
})
type TapeBlock = typeof TapeBlock.Type
const encodeBlock = Schema.encodeEffect(Schema.fromJsonString(TapeBlock))
const decodeBlock = Schema.decodeUnknownEffect(Schema.fromJsonString(TapeBlock))

// Where a block is stored, and its first trade's number and time.
const BlockEntry = Schema.Struct({
  // The segment's first trade, which names its object.
  segment: TradeNumber,
  offset: Schema.Int,
  length: Schema.Int,
  first: TradeNumber,
  firstTime: Schema.Finite,
})
type BlockEntry = typeof BlockEntry.Type

// The day's blocks, ascending, and whether its broker codes status was
// complete at the move.
const TapeIndex = Schema.Struct({
  complete: Schema.Boolean,
  blocks: Schema.Array(BlockEntry),
})
type TapeIndex = typeof TapeIndex.Type
const encodeIndex = Schema.encodeEffect(Schema.fromJsonString(TapeIndex))
const decodeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(TapeIndex))

// What the move reads the day's tape through.
export interface TapeSource {
  // The newest `limit` stored trades below `before`, or the day's newest
  // when it is none, ascending.
  readonly below: (
    before: TradeNumber | undefined,
    limit: number
  ) => Effect.Effect<ReadonlyArray<RunningTrade>, unknown>
  // The held codes of the listed trades, in their order.
  readonly codes: (
    tradeNumbers: ReadonlyArray<TradeNumber>
  ) => Effect.Effect<ReadonlyArray<readonly [TradeNumber, TradeCodes]>, unknown>
  readonly complete: Effect.Effect<boolean, unknown>
}

// Where a move stopped in the tape: below `before` (from the day's last
// trade when none), each segment written so far, newest first.
export const TapeProgress = Schema.Struct({
  before: Schema.optionalKey(TradeNumber),
  segments: Schema.Array(Schema.Array(BlockEntry)),
})
export type TapeProgress = typeof TapeProgress.Type

// One run of a day's tape move: the day's tape, where it writes, and the
// most segments it writes.
interface TapeRun {
  readonly date: WibDate
  readonly bucket: DayBucket
  readonly tape: TapeSource
  readonly segments: number
}

// Writes at most `run.segments` of the day's tape segments from where
// `progress` stopped, from the last trade back; once the first trade is
// written, the tape index. Answers where it stopped, none once the index is
// written. Each put rewrites the same key, so a retry is safe.
export const writeTapeRun = Effect.fnUntraced(function* (
  { date, bucket, tape, segments }: TapeRun,
  progress: TapeProgress
) {
  const keys = yield* dayKeys(date)
  const written = [...progress.segments]
  // The blocks read since the last segment, newest first.
  let held: Array<{
    bytes: Uint8Array
    first: TradeNumber
    firstTime: number
  }> = []
  const writeHeld = Effect.gen(function* () {
    const blocks = held.reverse()
    held = []
    const segment = blocks[0]!.first
    const body = new Uint8Array(
      blocks.reduce((sum, block) => sum + block.bytes.length, 0)
    )
    const entries: Array<BlockEntry> = []
    let offset = 0
    for (const block of blocks) {
      body.set(block.bytes, offset)
      entries.push({
        segment,
        offset,
        length: block.bytes.length,
        first: block.first,
        firstTime: block.firstTime,
      })
      offset += block.bytes.length
    }
    yield* putObject(
      bucket,
      keys.tapeSegment(segment),
      body,
      "application/octet-stream"
    )
    written.push(entries)
  })
  let before = progress.before
  for (let run = 0; run < segments;) {
    const trades = yield* tape.below(before, TAPE_BLOCK)
    const first = trades[0]
    if (first === undefined) break
    const codes = yield* tape.codes(trades.map((trade) => trade.tradeNumber))
    held.push({
      bytes: gzipSync(yield* encodeBlock({ trades, codes })),
      first: first.tradeNumber,
      firstTime: DateTime.toEpochMillis(first.time),
    })
    if (trades.length < TAPE_BLOCK) break
    before = first.tradeNumber
    if (held.length === BLOCKS_PER_SEGMENT) {
      yield* writeHeld
      run++
      if (run === segments)
        return { before, segments: written } satisfies TapeProgress
    }
  }
  if (held.length > 0) yield* writeHeld
  yield* putObject(
    bucket,
    keys.tapeIndex,
    yield* encodeIndex({
      complete: yield* tape.complete,
      blocks: written.reverse().flat(),
    }),
    "application/json"
  )
  return undefined
})

// An isolate keeps the tape indexes of the 8 cold days it read
// last, each about 125 KB on a busy day, so 1 MB at most: a cold day's index
// never changes, and a replay asks its day's tape again on every cursor
// move. A day read again after 8 others reads its index again.
const KEPT_INDEXES = 8

// Each bucket's tape indexes kept, by key, the one read longest ago first.
const indexes = new WeakMap<DayBucket, Map<string, TapeIndex>>()

const indexOf = Effect.fnUntraced(function* (bucket: DayBucket, key: string) {
  const kept = indexes.get(bucket) ?? new Map<string, TapeIndex>()
  indexes.set(bucket, kept)
  const known = kept.get(key)
  if (known !== undefined) {
    kept.delete(key)
    kept.set(key, known)
    return known
  }
  const stored = yield* Effect.promise(() => bucket.get(key))
  if (stored === null) return undefined
  const index = yield* decodeIndex(
    yield* Effect.promise(() => new Response(stored.body).text())
  )
  kept.set(key, index)
  for (const oldest of kept.keys()) {
    if (kept.size <= KEPT_INDEXES) break
    kept.delete(oldest)
  }
  return index
})

const blockOf = Effect.fnUntraced(function* (
  bucket: DayBucket,
  keys: DayKeys,
  entry: BlockEntry
) {
  const stored = yield* Effect.promise(() =>
    bucket.get(keys.tapeSegment(entry.segment), {
      range: { offset: entry.offset, length: entry.length },
    })
  )
  if (stored === null)
    return yield* Effect.die(`Tape segment ${entry.segment} is missing`)
  const bytes = yield* Effect.promise(() =>
    new Response(stored.body).arrayBuffer()
  )
  return yield* decodeBlock(
    new TextDecoder().decode(gunzipSync(new Uint8Array(bytes)))
  )
})

// The last index in `blocks` whose block passes `within`, which holds for a
// run of blocks from the first; -1 when none does.
const lastWithin = (
  blocks: ReadonlyArray<BlockEntry>,
  within: (block: BlockEntry) => boolean
) =>
  Effect.sync(() => {
    let low = 0
    let high = blocks.length - 1
    let found = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (within(blocks[middle]!)) {
        found = middle
        low = middle + 1
      } else high = middle - 1
    }
    return found
  })

// A trade picked for an answer, and its codes when the day held some.
interface Picked {
  readonly trade: RunningTrade
  readonly codes: TradeCodes | undefined
}

// The day's blocks, each read once per answer.
const blockReader = (
  bucket: DayBucket,
  keys: DayKeys,
  blocks: ReadonlyArray<BlockEntry>
) =>
  Effect.sync(() => {
    const read = new Map<number, TapeBlock>()
    return Effect.fnUntraced(function* (place: number) {
      const known = read.get(place)
      if (known !== undefined) return known
      const block = yield* blockOf(bucket, keys, blocks[place]!)
      read.set(place, block)
      return block
    })
  })
type BlockReader = Effect.Success<ReturnType<typeof blockReader>>

// The highest trade number an answer at the cursor may hold, picked as
// tape-chunks.ts's `tradesAt` picks it: the last trade at or before the
// instant plus TIME_SKEW_MS in the last block starting by then, lowered
// below `before`. None when no block starts by then.
const highestAt = Effect.fnUntraced(function* (
  blocks: ReadonlyArray<BlockEntry>,
  readBlock: BlockReader,
  cutoff: number,
  before: TapeCursor["before"]
) {
  const bound = cutoff + TIME_SKEW_MS
  const landing = yield* lastWithin(blocks, (block) => block.firstTime <= bound)
  if (landing < 0) return undefined
  const below = before === undefined ? Infinity : Number(before) - 1
  // A `before` under the landing block's first trade is the bound whatever
  // that block holds, so it isn't read.
  if (below < Number(blocks[landing]!.first))
    return TradeNumber.make(String(below))
  let found = 0
  for (const trade of (yield* readBlock(landing)).trades)
    if (DateTime.toEpochMillis(trade.time) <= bound)
      found = Number(trade.tradeNumber)
  return TradeNumber.make(String(Math.min(found, below)))
})

// The newest SNAPSHOT_TRADES trades numbered up to `highest` and at or
// before `cutoff`, ascending, read a block at a time down from `highest`'s.
const pickedDown = Effect.fnUntraced(function* (
  blocks: ReadonlyArray<BlockEntry>,
  readBlock: BlockReader,
  highest: TradeNumber,
  cutoff: number
) {
  const top = Number(highest)
  const picked: Array<Picked> = []
  const fits = (trade: RunningTrade) =>
    Number(trade.tradeNumber) <= top &&
    DateTime.toEpochMillis(trade.time) <= cutoff
  for (
    let place = yield* lastWithin(
      blocks,
      (block) => Number(block.first) <= top
    );
    place >= 0 && picked.length < SNAPSHOT_TRADES;
    place--
  ) {
    const block = yield* readBlock(place)
    const codes = new Map(block.codes)
    const fitting = block.trades.filter(fits)
    for (const trade of fitting
      .slice(picked.length - SNAPSHOT_TRADES)
      .reverse())
      picked.push({ trade, codes: codes.get(trade.tradeNumber) })
  }
  return picked.reverse()
})

// The newest SNAPSHOT_TRADES trades at the cursor, ascending, each with its
// codes, from the day's blocks.
const blockTradesAt = Effect.fnUntraced(function* (
  bucket: DayBucket,
  keys: DayKeys,
  blocks: ReadonlyArray<BlockEntry>,
  { at, before }: TapeCursor
) {
  const cutoff = DateTime.toEpochMillis(at)
  const readBlock = yield* blockReader(bucket, keys, blocks)
  const highest = yield* highestAt(blocks, readBlock, cutoff, before)
  return highest === undefined
    ? []
    : yield* pickedDown(blocks, readBlock, highest, cutoff)
})

// A cold day's Tape or BrokerCodes answer from its blocks; none when the day
// stored no tape index. The move wrote every byte it reads, so one that
// doesn't decode is a defect.
// The broker codes answer of a cold day is cached for good like
// the tape's, as its codes no longer change. See spec apinrdw/kumora#556,
// "Routing and caching".
export const coldTapeAnswer = Effect.fnUntraced(function* (
  bucket: DayBucket,
  date: WibDate,
  resource: TapeCursor & { readonly _tag: "Tape" | "BrokerCodes" }
) {
  const keys = yield* dayKeys(date)
  const index = yield* indexOf(bucket, keys.tapeIndex)
  if (index === undefined) return undefined
  const picked = yield* blockTradesAt(bucket, keys, index.blocks, resource)
  return yield* sealedAnswer(
    resource._tag === "Tape"
      ? yield* encodeRecordedTape({ trades: picked.map(({ trade }) => trade) })
      : yield* encodeRecordedBrokerCodes({
          codes: picked.flatMap(({ trade, codes }) =>
            codes === undefined ? [] : [[trade.tradeNumber, codes] as const]
          ),
          complete: index.complete,
        }),
    "plain"
  )
}, Effect.orDie)
