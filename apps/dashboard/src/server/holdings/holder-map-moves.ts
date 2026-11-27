// What changed on the Holder map (spec apinrdw/kumora#733, "Moves"): each
// link's move, stored or its key's blocks summed, its gap-holder mark and
// its crossing of 5%, and the leavings its Off list comes from.
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { type CustodianId, HolderKey } from "@/domain/holdings"
import { placeOf } from "@/lib/holder-map-ids"

import { holderKey } from "./holder-key.ts"
import { type Account, custodianOf } from "./holder-map-custodians.ts"
import {
  type KeyHolder,
  leftHolders,
  type Listed,
} from "./holder-map-holders.ts"
import {
  HolderMapLink,
  HolderMapMove,
  type HolderMapOffList,
  type StockLink,
} from "./holder-map-schema.ts"

// The 5% band's threshold, % × 100.
const FIVE_PERCENT = 500

// A holding's leaving of its list: an above-5% day's or an above-1%
// month's Off-list line.
export const LeavingRow = Schema.Struct({
  stock_code: StockCode,
  band: HolderMapLink.fields.band,
  name: Schema.String,
  data_date: WibDate,
  stake_before: Schema.Number,
})

// A month holder's newest leaving of the above-5% list since the month:
// its key's, one row each.
export const CrossingRow = Schema.Struct({
  stock_code: StockCode,
  holder_key: HolderKey,
  data_date: WibDate,
})

// A stored move of an identity listed in its band's period.
export const MoveRow = Schema.Struct({
  stock_code: StockCode,
  band: HolderMapLink.fields.band,
  name: Schema.String,
  move: HolderMapMove.fields.kind,
  share_change: Schema.NullOr(Schema.Number),
  percentage_change: Schema.NullOr(Schema.Number),
})

// Each holding's latest leaving of either list, by its place: its key's
// leavings of its newest period left, summed (`leftHolders`).
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
export const leavings = Effect.fnUntraced(function* (
  rows: ReadonlyArray<typeof LeavingRow.Type>
) {
  const byPlace = new Map<string, HolderMapOffList>()
  for (const left of yield* leftHolders(rows)) {
    const place = yield* placeOf(left.code, left.key)
    const known = byPlace.get(place)
    if (known !== undefined && known.since >= left.period) continue
    byPlace.set(place, {
      code: left.code,
      band: left.band,
      holder: left.key,
      name: left.sum.name,
      since: WibDate.make(left.period),
      percentageHundredths: left.sum.stakeBefore,
    })
  }
  return byPlace
})

// Each month holder's day it left the above-5% list since the month, by
// its place.
export const crossingsDown = Effect.fnUntraced(function* (
  rows: ReadonlyArray<typeof CrossingRow.Type>
) {
  const since = new Map<string, WibDate>()
  for (const row of rows)
    since.set(yield* placeOf(row.stock_code, row.holder_key), row.data_date)
  return since
})

// A move's place: its band and its holding's place.
const movePlace = (
  band: HolderMapLink["band"],
  code: StockCode,
  holder: HolderKey
) => Effect.map(placeOf(code, holder), (place) => `${band} ${place}`)

// Each stored move of an identity listed in its band's period, by its
// band and the place of its name's key: a key of one block on the day and
// on the day before, or any key of a month, is one identity (Major holders
// follows a month's holder by its key, ADR 0129), so its line is its move.
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
export const storedMoves = Effect.fnUntraced(function* (
  rows: ReadonlyArray<typeof MoveRow.Type>
) {
  const moves = new Map<string, typeof HolderMapMove.Type>()
  for (const row of rows) {
    const key = HolderKey.make(yield* holderKey(row.name))
    const place = yield* movePlace(row.band, row.stock_code, key)
    if (moves.has(place)) continue
    moves.set(place, {
      kind: row.move,
      shareChange: row.share_change ?? undefined,
      percentageChange: row.percentage_change ?? undefined,
    })
  }
  return moves
})

// A stock's 5%-band holders of the day and the day before, by key: the
// day before's only of keys with several blocks on either day.
interface DayHolders {
  readonly now: ReadonlyMap<HolderKey, KeyHolder<Listed>>
  readonly before: ReadonlyMap<HolderKey, KeyHolder<Listed>>
  // Whether the stock had a block on a day before: on its first, nothing
  // is compared, as Holder moves compares nothing there.
  readonly compared: boolean
}

// A 5%-band link's move. A key of one block on the day and at most one on
// the day before is one identity: its stored move (ADR 0134). A key of
// several blocks on either day moves by its blocks summed on both days, as
// one holder: New with none the day before, else Up or Down by its shares,
// its % change every block's on both days, else a Transfer when shares
// crossed custodians between its accounts, whichever blocks they sit in.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const dayMove = Effect.fnUntraced(function* (
  key: HolderKey,
  day: DayHolders,
  stored: typeof HolderMapMove.Type | undefined
) {
  const now = day.now.get(key)
  const before = day.before.get(key)
  if (now === undefined || (now.blocks === 1 && (before?.blocks ?? 0) <= 1))
    return stored
  if (before === undefined)
    return day.compared
      ? ({
          kind: "new",
          shareChange: now.sum.shares,
          percentageChange: undefined,
        } satisfies typeof HolderMapMove.Type)
      : undefined
  const shareChange = now.sum.shares - before.sum.shares
  const percentageChange = now.sum.hundredths - before.sum.hundredths
  if (shareChange !== 0)
    return {
      kind: shareChange > 0 ? "up" : "down",
      shareChange,
      percentageChange,
    } satisfies typeof HolderMapMove.Type
  return (yield* crossedCustodians(before.sum.accounts, now.sum.accounts))
    ? ({
        kind: "transfer",
        shareChange,
        percentageChange,
      } satisfies typeof HolderMapMove.Type)
    : undefined
})

// Whether shares left some custodians for others between two days'
// securities accounts: each custodian's accounts netted, a custodian as
// one by its broker code, else its name (`custodianOf`), so shares moved
// between accounts at one custodian cancel out.
//
// Decision: broker codes are looked up on read
// (apps/dashboard/docs/adr/0132-broker-codes-are-looked-up-on-read.md)
const crossedCustodians = Effect.fnUntraced(function* (
  before: ReadonlyArray<Account>,
  now: ReadonlyArray<Account>
) {
  const net = new Map<CustodianId, number>()
  for (const [accounts, sign] of [
    [before, -1],
    [now, 1],
  ] as const)
    for (const { custodian, scripless } of accounts) {
      const { id } = yield* custodianOf(custodian)
      net.set(id, (net.get(id) ?? 0) + sign * scripless)
    }
  return [...net.values()].some((change) => change !== 0)
})

// What changed since each band's period before, and across the bands'
// periods: a stock's links' stored moves, the gap-holder mark, and a
// crossing of 5%.
export const changesOf = Effect.fnUntraced(function* (
  periods: {
    readonly day: WibDate | undefined
    readonly month: WibDate | undefined
  },
  stock: {
    readonly links: ReadonlyArray<StockLink>
    readonly day: DayHolders
    // Each month holder's %, by key.
    readonly inMonth: ReadonlyMap<HolderKey, number>
  },
  moves: ReadonlyMap<string, typeof HolderMapMove.Type>,
  // Each month holder's day it left the above-5% list, by place.
  downSince: ReadonlyMap<string, WibDate>
) {
  const out: Array<HolderMapLink> = []
  for (const link of stock.links) {
    const place = yield* placeOf(link.code, link.holder)
    const stored = moves.get(
      yield* movePlace(link.band, link.code, link.holder)
    )
    out.push({
      ...link,
      move:
        link.band === "5%"
          ? yield* dayMove(link.holder, stock.day, stored)
          : stored,
      gap:
        link.band === "1%" &&
        periods.day !== undefined &&
        link.percentageHundredths >= FIVE_PERCENT,
      crossing: yield* crossingOf(
        link,
        periods.month,
        stock.inMonth.get(link.holder),
        downSince.get(place)
      ),
    })
  }
  return out
})

const crossingOf = (
  link: StockLink,
  month: WibDate | undefined,
  monthHundredths: number | undefined,
  down: WibDate | undefined
) =>
  Effect.sync((): HolderMapLink["crossing"] => {
    if (
      link.band === "5%" &&
      monthHundredths !== undefined &&
      monthHundredths < FIVE_PERCENT
    )
      return { kind: "up into 5%", monthHundredths }
    if (
      link.band === "1%" &&
      down !== undefined &&
      month !== undefined &&
      down > month
    )
      return { kind: "down out of 5%", since: down }
    return undefined
  })
