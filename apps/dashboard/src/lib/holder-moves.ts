// The Holder moves page's view model (spec apinrdw/kumora#673, "Holder
// moves"; apinrdw/kumora#679): from the Holder moves read, every holder that
// moved in the selected period across the market, and the rail's periods'
// counts, each by the Daily holders view model's rules, so the page and a
// stock's Daily holders never disagree.
import type { BrokerCode, StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { type MoveKind, RAIL_PERIODS } from "@/domain/holdings"
import { dailyHolders, type HoldersDay } from "@/lib/daily-holders"
import type { HolderId, Move, TrendCell } from "@/lib/holder-identity"
import type {
  HolderMovesRead,
  MovesStock,
} from "@/server/holdings/holder-moves"
import type { DailyHoldersDay } from "@/server/holdings/stock-page"

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
  // Undefined for a New or Off-list holder, whose shares under the
  // threshold the report doesn't give.
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
  readonly period: string
  // The period the moves are against; undefined on the first parsed one.
  readonly against: string | undefined
  // By stock code, then most % first.
  readonly lines: ReadonlyArray<MoveLine>
  readonly counts: MoveCounts
  // The stocks with a line.
  readonly stockCount: number
  // The last RAIL_PERIODS periods with one before, oldest first.
  readonly rail: ReadonlyArray<{
    readonly period: string
    readonly counts: MoveCounts
  }>
}

const NO_MOVES: MoveCounts = { new: 0, up: 0, down: 0, offList: 0 }

// The stock's days that run, one parsed period after another, up to `period`
// and at most `length` long; none when it doesn't have that period.
const runTo = (
  stock: MovesStock,
  periods: ReadonlyArray<string>,
  period: string,
  length: number
) =>
  Effect.sync(() => {
    const at = stock.days.findIndex(({ dataDate }) => dataDate === period)
    if (at === -1) return []
    let start = at
    while (
      start > 0 &&
      at - start + 1 < length &&
      periods.indexOf(stock.days[start - 1]?.dataDate ?? "") ===
        periods.indexOf(stock.days[start]?.dataDate ?? "") - 1
    )
      start -= 1
    return stock.days.slice(start, at + 1)
  })

const countsOn = Effect.fnUntraced(function* (
  stocks: ReadonlyArray<MovesStock>,
  periods: ReadonlyArray<string>,
  period: string
) {
  let sum = NO_MOVES
  for (const stock of stocks) {
    const pair = yield* runTo(stock, periods, period, 2)
    const held = yield* dailyHolders(pair, period)
    const counts = held?.dataDate === period ? held.counts : undefined
    if (counts === undefined) continue
    sum = {
      new: sum.new + counts.new,
      up: sum.up + counts.up,
      down: sum.down + counts.down,
      offList: sum.offList + counts.offList,
    }
  }
  return sum
})

const stakeOf = ({ stake }: MoveLine) => stake.now ?? stake.before ?? 0

// The selected period's moves and the rail; undefined when nothing is
// parsed.
export const holderMovesView = Effect.fnUntraced(function* (
  read: HolderMovesRead
): Effect.fn.Return<HolderMoves | undefined> {
  const { period, periods, stocks } = read
  if (period === undefined) return undefined
  const lines: Array<MoveLine> = []
  for (const stock of stocks) {
    // The selected day, the trend's 19 days before it, and the day before
    // those for the oldest bar.
    const run: ReadonlyArray<DailyHoldersDay> = yield* runTo(
      stock,
      periods,
      period,
      21
    )
    const held: HoldersDay | undefined = yield* dailyHolders(run, period)
    if (held?.dataDate !== period) continue
    for (const line of [...held.listed, ...held.offList]) {
      if (line.move === undefined || line.move === "unchanged") continue
      lines.push({
        code: stock.code,
        issuerName: stock.issuerName,
        holder: line.holder,
        name: line.name,
        aliases: line.aliases,
        renamedFrom: line.renamedFrom,
        move: line.move,
        through: line.through,
        shareChange: line.shareChange,
        stake: line.stake,
        percentageChange: line.percentageChange,
        trend: line.trend,
      })
    }
  }
  lines.sort((a, b) => a.code.localeCompare(b.code) || stakeOf(b) - stakeOf(a))
  const counted = (move: MoveLine["move"]) =>
    lines.filter((line) => line.move === move).length
  return {
    kind: read.kind,
    period,
    against: periods[periods.indexOf(period) - 1],
    lines,
    counts: {
      new: counted("new"),
      up: counted("up"),
      down: counted("down"),
      offList: counted("off list"),
    },
    stockCount: new Set(lines.map(({ code }) => code)).size,
    rail: yield* Effect.forEach(
      periods.slice(1).slice(-RAIL_PERIODS),
      Effect.fnUntraced(function* (each) {
        return {
          period: each,
          counts: yield* countsOn(stocks, periods, each),
        }
      })
    ),
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
