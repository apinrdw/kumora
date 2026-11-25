// The Holder moves page's view model (spec apinrdw/kumora#673, "Holder
// moves"; apinrdw/kumora#679, #680): from the Holder moves read, every
// holder that moved in the selected period across the market, and the
// rail's periods' counts, each by the Daily holders view model's rules for a
// day or Major holders' for a month, as the period's parse run derived them
// (server/holdings/derived-moves.ts), so the page and a stock's panel never
// disagree.
import type { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import type { MoveKind } from "@/domain/holdings"
import { throughOf } from "@/lib/daily-holders"
import type { HolderId, Move, TrendCell } from "@/lib/holder-identity"
import type {
  DerivedMoveLine,
  HolderMovesRead,
} from "@/server/holdings/holder-moves"

// What a filter button shows: every move, or one kind of move.
const MOVE_FILTERS = ["all", "new", "up", "down", "off list"] as const
export type MoveFilter = (typeof MOVE_FILTERS)[number]

export interface MoveLine {
  readonly code: StockCode
  readonly issuerName: string
  readonly holder: HolderId
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly renamedFrom: string | undefined
  readonly move: Exclude<Move, "unchanged">
  readonly through: ReadonlyArray<BrokerCode | "custodian">
  // Against the period before: a New holder's whole holding, an Off-list
  // holder's whole last holding out, as the report gives no shares under
  // its threshold.
  readonly shareChange: number | undefined
  // % × 100; absent on the side where it isn't listed.
  readonly stake: { readonly before?: number; readonly now?: number }
  readonly percentageChange: number | undefined
  readonly trend: ReadonlyArray<TrendCell>
}

export interface MoveCounts {
  readonly new: number
  readonly up: number
  readonly down: number
  readonly offList: number
}

export interface HolderMoves {
  readonly kind: MoveKind
  // A data date: Daily's trading day, or Monthly's report month's.
  readonly period: WibDate
  // The period the moves are against; undefined on the first parsed one.
  readonly against: WibDate | undefined
  // By stock code, then most % first.
  readonly lines: ReadonlyArray<MoveLine>
  readonly counts: MoveCounts
  // The stocks with a line.
  readonly stockCount: number
  // The last RAIL_PERIODS periods with one before, oldest first.
  readonly rail: ReadonlyArray<{
    readonly period: WibDate
    readonly counts: MoveCounts
  }>
}

// A derived line, its Through's custodians as broker codes.
const derivedLine = Effect.fnUntraced(function* (line: DerivedMoveLine) {
  const { custodians, ...rest } = line
  return {
    ...rest,
    holder: line.holder as HolderId,
    through: yield* throughOf(custodians),
  } satisfies MoveLine
})

const stakeOf = ({ stake }: MoveLine) => stake.now ?? stake.before ?? 0

// The selected period's moves and the rail; undefined when nothing is
// parsed.
export const holderMovesView = Effect.fnUntraced(function* (
  read: HolderMovesRead
): Effect.fn.Return<HolderMoves | undefined> {
  const { period, rail, against } = read
  if (period === undefined) return undefined
  const lines = yield* Effect.forEach(read.lines, derivedLine)
  lines.sort((a, b) => a.code.localeCompare(b.code) || stakeOf(b) - stakeOf(a))
  const counted = (move: MoveLine["move"]) =>
    lines.filter((line) => line.move === move).length
  return {
    kind: read.kind,
    period,
    against,
    lines,
    counts: {
      new: counted("new"),
      up: counted("up"),
      down: counted("down"),
      offList: counted("off list"),
    },
    stockCount: new Set(lines.map(({ code }) => code)).size,
    rail,
  } satisfies HolderMoves
})

// The lines `filter` keeps whose stock code, issuer name or holder name
// holds `search`, or whose Through has it as a broker code, any case.
export const visibleLines = (
  lines: ReadonlyArray<MoveLine>,
  filter: MoveFilter,
  search: string
) =>
  Effect.sync(() => {
    const term = search.trim().toUpperCase()
    return lines.filter(
      (line) =>
        (filter === "all" || line.move === filter) &&
        (term === "" ||
          line.code.includes(term) ||
          line.issuerName.toUpperCase().includes(term) ||
          line.name.toUpperCase().includes(term) ||
          line.through.some((broker) => broker === term))
    )
  })
