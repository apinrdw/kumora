// The Holder moves page's view model (spec apinrdw/kumora#673, "Holder
// moves"; apinrdw/kumora#679, #680): from the Holder moves read, every
// holder that moved in the selected period across the market, and the
// rail's periods' counts, each by the Daily holders view model's rules for a
// day or Major holders' for a month, so the page and a stock's panel never
// disagree.
import type { BrokerCode, StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { type MoveKind, RAIL_PERIODS } from "@/domain/holdings"
import { dailyHolders, type HoldersDay } from "@/lib/daily-holders"
import type { HolderId, Move, TrendCell } from "@/lib/holder-identity"
import { majorHolders, type MonthHolders } from "@/lib/major-holders"
import type {
  HolderMovesRead,
  MonthlyMovesStock,
  MovesStock,
} from "@/server/holdings/holder-moves"
import type {
  DailyHoldersDay,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

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

// The stock's periods that run, one parsed period after another, up to
// `period` and at most `length` long; none when it doesn't have that period.
const runTo = <P extends { readonly dataDate: string }>(
  held: ReadonlyArray<P>,
  periods: ReadonlyArray<string>,
  period: string,
  length: number
) =>
  Effect.sync(() => {
    const at = held.findIndex(({ dataDate }) => dataDate === period)
    if (at === -1) return []
    let start = at
    while (
      start > 0 &&
      at - start + 1 < length &&
      periods.indexOf(held[start - 1]?.dataDate ?? "") ===
        periods.indexOf(held[start]?.dataDate ?? "") - 1
    )
      start -= 1
    return held.slice(start, at + 1)
  })

// A stock of the read: its lines in the selected period, and its counts in
// any period of the rail, each by its kind's panel.
interface StockMoves {
  readonly lines: Effect.Effect<ReadonlyArray<MoveLine>>
  readonly countsOn: (period: string) => Effect.Effect<MoveCounts | undefined>
}

const moved = <M extends Move | undefined>(
  move: M
): move is Exclude<M, "unchanged" | undefined> =>
  move !== undefined && move !== "unchanged"

// A Daily stock, by its Daily holders.
const dailyStock = (
  stock: MovesStock,
  periods: ReadonlyArray<string>,
  period: string
): StockMoves => ({
  lines: Effect.gen(function* () {
    // The selected day, the trend's 19 days before it, and the day before
    // those for the oldest bar.
    const run: ReadonlyArray<DailyHoldersDay> = yield* runTo(
      stock.days,
      periods,
      period,
      TREND_RUN
    )
    const held: HoldersDay | undefined = yield* dailyHolders(run, period)
    if (held?.dataDate !== period) return []
    return [...held.listed, ...held.offList].flatMap((line): Array<MoveLine> =>
      moved(line.move)
        ? [
            {
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
            },
          ]
        : []
    )
  }),
  countsOn: Effect.fnUntraced(function* (each) {
    const held = yield* dailyHolders(
      yield* runTo(stock.days, periods, each, 2),
      each
    )
    return held?.dataDate === each ? held.counts : undefined
  }),
})

// An above-1% month's holders of the stock, by its Major holders; undefined
// when it has none in that month.
const majorHoldersIn = Effect.fnUntraced(function* (
  months: ReadonlyArray<MajorHoldersMonth>,
  period: string
) {
  const held: MonthHolders | undefined = yield* majorHolders(
    months,
    period.slice(0, 7)
  )
  return held?.dataDate === period ? held : undefined
})

// A Monthly stock, by its Major holders: no Through, and the stake under
// 1% on the side it isn't listed.
const monthlyStock = (
  stock: MonthlyMovesStock,
  periods: ReadonlyArray<string>,
  period: string
): StockMoves => ({
  lines: Effect.gen(function* () {
    const held = yield* majorHoldersIn(
      yield* runTo(stock.months, periods, period, TREND_RUN),
      period
    )
    if (held === undefined) return []
    return [...held.listed, ...held.offList].flatMap((line): Array<MoveLine> =>
      moved(line.change)
        ? [
            {
              code: stock.code,
              issuerName: stock.issuerName,
              holder: line.holder,
              name: line.name,
              aliases: [],
              renamedFrom: undefined,
              move: line.change,
              through: [],
              shareChange: line.shareChange,
              stake:
                line.change === "off list"
                  ? { before: line.percentageHundredths }
                  : {
                      before:
                        line.percentageChange === undefined
                          ? undefined
                          : line.percentageHundredths - line.percentageChange,
                      now: line.percentageHundredths,
                    },
              percentageChange: line.percentageChange,
              trend: line.trend,
            },
          ]
        : []
    )
  }),
  countsOn: Effect.fnUntraced(function* (each) {
    const held = yield* majorHoldersIn(
      yield* runTo(stock.months, periods, each, 2),
      each
    )
    return held?.counts
  }),
})

// The selected period, the trend's 19 before it, and the one before those
// for the oldest bar.
const TREND_RUN = 21

const stakeOf = ({ stake }: MoveLine) => stake.now ?? stake.before ?? 0

// The selected period's moves and the rail; undefined when nothing is
// parsed.
export const holderMovesView = Effect.fnUntraced(function* (
  read: HolderMovesRead
): Effect.fn.Return<HolderMoves | undefined> {
  const { period, periods } = read
  if (period === undefined) return undefined
  const stocks: ReadonlyArray<StockMoves> =
    read.kind === "daily"
      ? read.stocks.map((stock) => dailyStock(stock, periods, period))
      : read.stocks.map((stock) => monthlyStock(stock, periods, period))
  const lines = (yield* Effect.forEach(stocks, (stock) => stock.lines)).flat()
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
        let counts = NO_MOVES
        for (const stock of stocks) {
          const of = yield* stock.countsOn(each)
          if (of === undefined) continue
          counts = {
            new: counts.new + of.new,
            up: counts.up + of.up,
            down: counts.down + of.down,
            offList: counts.offList + of.offList,
          }
        }
        return { period: each, counts }
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
