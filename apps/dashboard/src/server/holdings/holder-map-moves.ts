// What changed on the Holder map (spec apinrdw/kumora#733, "Moves"): each
// link's stored move, its gap-holder mark and its crossing of 5%, and the
// leavings its Off list and crossings come from.
//
// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import type { HolderKey } from "@/domain/holdings"
import { placeOf } from "@/lib/holder-map-ids"

import {
  type KeyHolder,
  leftHolders,
  lineHolders,
  type Lines,
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

export const MoveRow = Schema.Struct({
  stock_code: StockCode,
  band: HolderMapLink.fields.band,
  name: Schema.String,
  data_date: WibDate,
  move: Schema.Literals([...HolderMapMove.fields.kind.literals, "off list"]),
  share_change: Schema.NullOr(Schema.Number),
  percentage_change: Schema.NullOr(Schema.Number),
  stake_before: Schema.NullOr(Schema.Number),
  stake_now: Schema.NullOr(Schema.Number),
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

// A move's place: its band and its holding's place.
const movePlace = (
  band: HolderMapLink["band"],
  code: StockCode,
  holder: HolderKey
) => Effect.map(placeOf(code, holder), (place) => `${band} ${place}`)

// Each stock's bands' stored lines summed by holder key (`lineHolders`).
// Holder moves follows a holder by its identity within the stock (ADR
// 0129), the map by key, so a key whose blocks are two identities, as
// CPGT's two ASIA ARGENTUM ASSETS HONG KONG LIMITED blocks, moves by their
// lines together (`keyMove`). Each band's lines are of its one period.
export const movesByKey = Effect.fnUntraced(function* (
  rows: ReadonlyArray<typeof MoveRow.Type>
) {
  const moves = new Map<string, KeyHolder<Lines>>()
  for (const holder of yield* lineHolders(rows))
    moves.set(yield* movePlace(holder.band, holder.code, holder.key), holder)
  return moves
})

// A listed key's move from its lines, `blocks` its identities listed now.
// A block that holds as it did has no line, so the lines alone can't tell
// a key's total: one line of its only block is that block's stored move.
// Else the key moved by its lines' summed change, as its unchanged blocks
// add nothing: New only when every block listed now is New and none left,
// and a block's leaving, its whole last holding out, counts toward Down,
// never Off list, as the key is still listed.
const keyMove = Effect.fnUntraced(function* (
  lines: KeyHolder<Lines> | undefined,
  blocks: number
) {
  if (lines === undefined) return undefined
  const { moves, shareChange, percentageChange, stakeBefore, stakeNow } =
    lines.sum
  const [only] = moves
  if (only === undefined) return undefined
  if (lines.blocks === 1 && blocks === 1 && only !== "off list")
    return {
      kind: only,
      shareChange: shareChange ?? undefined,
      percentageChange: percentageChange ?? undefined,
    } satisfies typeof HolderMapMove.Type
  if (lines.blocks === blocks && moves.every((move) => move === "new"))
    return {
      kind: "new",
      shareChange: shareChange ?? undefined,
      percentageChange: undefined,
    } satisfies typeof HolderMapMove.Type
  const kind = yield* summedKind(
    lines.band === "5%" ? (shareChange ?? undefined) : stakeNow - stakeBefore,
    moves.includes("transfer")
  )
  return kind === undefined
    ? undefined
    : ({
        kind,
        shareChange: shareChange ?? undefined,
        percentageChange: stakeNow - stakeBefore,
      } satisfies typeof HolderMapMove.Type)
})

// A key's summed move, by shares on a day and by % on a month, as each
// report's moves go.
const summedKind = (change: number | undefined, transfer: boolean) =>
  Effect.succeed<typeof HolderMapMove.Type.kind | undefined>(
    change === undefined || change === 0
      ? transfer
        ? "transfer"
        : undefined
      : change > 0
        ? "up"
        : "down"
  )

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
    // Each 5%-band holder's blocks listed on the day, by key.
    readonly blocks: ReadonlyMap<HolderKey, number>
    // Each month holder's %, by key.
    readonly inMonth: ReadonlyMap<HolderKey, number>
  },
  moves: ReadonlyMap<string, KeyHolder<Lines>>,
  leftAbove5: ReadonlyMap<string, HolderMapOffList>
) {
  const out: Array<HolderMapLink> = []
  for (const link of stock.links) {
    const place = yield* placeOf(link.code, link.holder)
    out.push({
      ...link,
      move: yield* keyMove(
        moves.get(yield* movePlace(link.band, link.code, link.holder)),
        link.band === "5%" ? (stock.blocks.get(link.holder) ?? 1) : 1
      ),
      gap:
        link.band === "1%" &&
        periods.day !== undefined &&
        link.percentageHundredths >= FIVE_PERCENT,
      crossing: yield* crossingOf(
        link,
        periods.month,
        stock.inMonth.get(link.holder),
        leftAbove5.get(place)
      ),
    })
  }
  return out
})

const crossingOf = (
  link: StockLink,
  month: WibDate | undefined,
  monthHundredths: number | undefined,
  left: HolderMapOffList | undefined
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
      left !== undefined &&
      month !== undefined &&
      left.since > month
    )
      return { kind: "down out of 5%", since: left.since }
    return undefined
  })
