// The Holder moves page (apinrdw/kumora#679, #680; spec apinrdw/kumora#673's
// prototype): every above-5% holder that moved on one trading day (Daily),
// or ≥1% holder in one above-1% report month (Monthly), across the market,
// filtered by move and searched, beside a rail of the last periods' counts
// and the holders that entered or left the list. A row opens its stock's
// Daily holders at that day, or Major holders in that month.
import { Link } from "@tanstack/react-router"
import type { WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { BoundedRows } from "@/components/k/bounded-rows"
import { kCard, kFocus } from "@/components/k/styles"
import {
  Change,
  LotsChange,
  MoveChip,
  offListText,
  percentChangeText,
  percentOf,
  stakeChangeText,
  THRESHOLDS,
  ThroughChips,
  Trend,
} from "@/components/stocks/holder-cells"
import { monthOf, type MoveKind, TREND_PERIODS } from "@/domain/holdings"
import { count } from "@/lib/format"
import {
  type HolderMoves,
  type MoveCounts,
  type MoveFilter,
  type MoveLine,
  visibleLines,
} from "@/lib/holder-moves"
import { dayDateLabel, monthLabel } from "@/lib/stock-page-display"
import type { StockSearch } from "@/lib/stock-search"

export type HolderMovesPageProps = {
  kind: MoveKind
  // Undefined when no period of `kind` is parsed.
  moves: HolderMoves | undefined
  filter: MoveFilter
  search: string
  onFilter: (filter: MoveFilter) => void
  onSearch: (search: string) => void
  onPeriod: (period: WibDate) => void
  onKind: (kind: MoveKind) => void
}

const COLUMNS = [
  ["Stock", "text-left"],
  ["Holder", "text-left"],
  ["Move", "text-left"],
  ["Through", "text-left"],
  ["Lots", "text-right"],
  ["Stake", "text-right"],
  ["Change", "text-right"],
  ["Trend", "text-right"],
] as const
type Column = (typeof COLUMNS)[number]

// Where a row leads: its stock's panel of the kind, at the period.
interface StockLink {
  readonly search: Pick<StockSearch, "holdersDay" | "holdersMonth">
  readonly hash: string
}

// What differs between a trading day's above-5% moves and a month's ≥1%.
const KINDS: Record<
  MoveKind,
  {
    readonly label: string
    readonly period: (date: WibDate) => Effect.Effect<string>
    // The rail's tick under a period's bars.
    readonly tick: (date: WibDate) => Effect.Effect<string>
    readonly unit: string
    readonly units: string
    // How the headline puts the period: "on 20 Nov 2026", "in Oct 2026".
    readonly at: string
    readonly columns: ReadonlyArray<Column>
    readonly link: (period: WibDate) => Effect.Effect<StockLink>
    readonly note: string
  }
> = {
  daily: {
    label: "Daily",
    period: dayDateLabel,
    tick: (date) => Effect.succeed(date.slice(8, 10)),
    unit: "day",
    units: "trading days",
    at: "on",
    columns: COLUMNS,
    link: (holdersDay) =>
      Effect.succeed({ search: { holdersDay }, hash: "daily-holders" }),
    note: `Percent of listed shares as IDX publishes it each trading day; holders under 5% are not listed. Moves follow shares, against the parsed day before. Lots: the change in shares, a New holder's whole holding in and an Off-list holder's last out. Through: the broker codes of the accounts whose shares changed, largest change first; Custodian for an account at a bank or other custodian that is not an exchange member. Transfer: the holder's total is unchanged but shares moved from accounts at some brokers to accounts at others, shown from → to with the lots that moved. Trend: the change in lots on each of the last ${TREND_PERIODS} trading days up to the selected one, blue where the holder entered the list, grey where it left, a tick where it transferred.`,
  },
  monthly: {
    label: "Monthly",
    period: monthLabel,
    tick: (date) => Effect.map(monthLabel(date), (label) => label.slice(0, 3)),
    unit: "month",
    units: "months",
    at: "in",
    // The above-1% report lists no accounts.
    columns: COLUMNS.filter(([label]) => label !== "Through"),
    link: (period) =>
      Effect.map(monthOf(period), (holdersMonth) => ({
        search: { holdersMonth },
        hash: "major-holders",
      })),
    note: `Percent of listed shares as IDX publishes it each month; holders under 1% are not listed. Moves follow the change in percent against the report month before, as Major holders' do. Lots: the change in total holding, scrip included, a New holder's whole holding in and an Off-list holder's last out. Trend: the change in lots in each of the last ${TREND_PERIODS} report months up to the selected one, blue where the holder entered the list and grey where it left.`,
  },
}

const FILTERS: ReadonlyArray<{
  filter: MoveFilter
  label: string
  of: (counts: MoveCounts) => number
}> = [
  {
    filter: "all",
    label: "All",
    of: (counts) =>
      counts.new + counts.up + counts.down + counts.transfer + counts.offList,
  },
  { filter: "new", label: "New", of: (counts) => counts.new },
  { filter: "up", label: "Up", of: (counts) => counts.up },
  { filter: "down", label: "Down", of: (counts) => counts.down },
  { filter: "transfer", label: "Transfer", of: (counts) => counts.transfer },
  { filter: "off list", label: "Off list", of: (counts) => counts.offList },
]

// The filters a kind offers: a month has no accounts, so no Transfer.
const filtersOf = (kind: MoveKind) =>
  kind === "daily"
    ? FILTERS
    : FILTERS.filter(({ filter }) => filter !== "transfer")

export function HolderMovesPage({
  kind,
  moves,
  filter,
  search,
  onFilter,
  onSearch,
  onPeriod,
  onKind,
}: HolderMovesPageProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">
            Holder moves
          </h1>
          <div
            role="group"
            aria-label="Kind"
            className="bg-surface inline-flex gap-0.5 rounded-md border border-border p-0.5"
          >
            {(Object.keys(KINDS) as ReadonlyArray<MoveKind>).map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={kind === each}
                onClick={() => onKind(each)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-[12.5px] font-semibold text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground",
                  kFocus
                )}
              >
                {KINDS[each].label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[13px] text-muted-foreground">
          {moves === undefined
            ? `No ${KINDS[kind].unit} of IDX's above-${THRESHOLDS[kind]} report is parsed yet.`
            : Effect.runSync(headline(moves))}
        </p>
      </div>
      {moves && (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section
            aria-label="Moves"
            className={cn(kCard, "flex min-w-0 flex-col gap-3")}
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <div
                role="group"
                aria-label="Move"
                className="bg-surface inline-flex gap-0.5 rounded-md border border-border p-0.5"
              >
                {filtersOf(moves.kind).map((each) => (
                  <button
                    key={each.filter}
                    type="button"
                    aria-pressed={filter === each.filter}
                    onClick={() => onFilter(each.filter)}
                    className={cn(
                      "rounded-sm px-2.5 py-1 text-[12.5px] font-semibold text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground",
                      kFocus
                    )}
                  >
                    {each.label}
                    <span className="num ml-1 font-normal opacity-80">
                      {each.of(moves.counts)}
                    </span>
                  </button>
                ))}
              </div>
              <input
                type="search"
                aria-label="Search stock, holder or broker"
                placeholder="Stock, holder, broker"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                className={cn(
                  "bg-surface w-full max-w-70 rounded-md border border-border px-2.5 py-1.5 text-[13px]",
                  kFocus
                )}
              />
            </div>
            <MovesTable
              moves={moves}
              lines={Effect.runSync(visibleLines(moves.lines, filter, search))}
            />
            <p className="text-[12px] text-muted-foreground">
              {KINDS[moves.kind].note}
            </p>
          </section>
          <Rail moves={moves} onPeriod={onPeriod} />
        </div>
      )}
    </div>
  )
}

const headline = Effect.fnUntraced(function* (moves: HolderMoves) {
  const of = KINDS[moves.kind]
  const period = yield* of.period(moves.period)
  if (moves.against === undefined)
    return `${period} is the first ${of.unit} parsed, so nothing to compare it with.`
  const threshold = THRESHOLDS[moves.kind]
  const moved = yield* count(
    moves.lines.length,
    `holder above ${threshold} moved`,
    `holders above ${threshold} moved`
  )
  const stocks = yield* count(moves.stockCount, "stock", "stocks")
  return `${moved} across ${stocks} ${of.at} ${period}, against ${yield* of.period(moves.against)}.`
})

function MovesTable({
  moves,
  lines,
}: {
  moves: HolderMoves
  lines: ReadonlyArray<MoveLine>
}) {
  const of = KINDS[moves.kind]
  const { columns } = of
  const empty =
    moves.against === undefined
      ? `Nothing to compare on the first ${of.unit} parsed.`
      : moves.lines.length === 0
        ? `No holder above ${THRESHOLDS[moves.kind]} moved ${of.at} ${Effect.runSync(of.period(moves.period))}.`
        : "No holder matches. Clear the search or pick All."
  return (
    <div className="overflow-x-auto">
      <table
        aria-label="Holder moves"
        className="w-full min-w-245 text-[13px] [&_td]:px-2 [&_td]:py-2 [&_td]:align-top [&_th]:px-2 [&_th]:py-2 [&_th]:align-top"
      >
        <thead className="border-b border-border [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground">
          <tr>
            {columns.map(([label, align]) => (
              <th key={label} scope="col" className={align}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="text-muted-foreground">
                {empty}
              </td>
            </tr>
          ) : (
            // Decision: a page renders a list of stored rows through BoundedRows
            // (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
            <BoundedRows rows={lines}>
              {(line) => (
                <MoveRow
                  key={`${line.code} ${line.holder}`}
                  line={line}
                  kind={moves.kind}
                  period={moves.period}
                />
              )}
            </BoundedRows>
          )}
        </tbody>
      </table>
    </div>
  )
}

function MoveRow({
  line,
  kind,
  period,
}: {
  line: MoveLine
  kind: MoveKind
  period: WibDate
}) {
  return (
    <tr data-move className="border-t border-border">
      {KINDS[kind].columns.map(([column]) => (
        <MoveCell
          key={column}
          column={column}
          line={line}
          kind={kind}
          period={period}
        />
      ))}
    </tr>
  )
}

function MoveCell({
  column,
  line,
  kind,
  period,
}: {
  column: Column[0]
  line: MoveLine
  kind: MoveKind
  period: WibDate
}) {
  switch (column) {
    case "Stock": {
      const { search, hash } = Effect.runSync(KINDS[kind].link(period))
      return (
        <td className="whitespace-nowrap">
          <Link
            to="/stocks/$code"
            params={{ code: line.code }}
            search={search}
            hash={hash}
            aria-label={`${line.code} ${line.issuerName}`}
            className={cn("rounded-xs hover:underline", kFocus)}
          >
            <span className="num font-semibold">{line.code}</span>
            <span className="ml-2 text-[12px] text-muted-foreground">
              {line.issuerName}
            </span>
          </Link>
        </td>
      )
    }
    case "Holder":
      return (
        <th scope="row" className="min-w-56 text-left font-normal">
          <div className="font-medium">{line.name}</div>
          {line.renamedFrom && (
            <div className="text-[12px] text-muted-foreground">
              Renamed from {line.renamedFrom}
            </div>
          )}
          {line.aliases.length > 0 && (
            <div className="text-[12px] text-muted-foreground">
              Also listed as {line.aliases.join("; ")}
            </div>
          )}
        </th>
      )
    case "Move":
      return (
        <td>
          <MoveChip
            move={line.move}
            since={undefined}
            offListTip={Effect.runSync(offListText(kind))}
          />
        </td>
      )
    case "Through":
      return (
        <td data-through>
          <ThroughChips through={line.through} transfer={line.transfer} />
        </td>
      )
    case "Lots":
      return (
        <td className="num text-right whitespace-nowrap">
          <LotsChange shareChange={line.shareChange} transfer={line.transfer} />
        </td>
      )
    case "Stake":
      return (
        <td className="num text-right whitespace-nowrap">
          {Effect.runSync(stakeChangeText(line.stake, kind))}
        </td>
      )
    case "Change":
      return (
        <td className="num text-right whitespace-nowrap">
          <Change value={line.percentageChange} text={percentChangeText} />
        </td>
      )
    case "Trend":
      return (
        <td className="text-right">
          <Trend
            cells={line.trend}
            name={line.name}
            periods={KINDS[kind].units}
          />
        </td>
      )
  }
}

const BAR_HEIGHT = 64

function Rail({
  moves,
  onPeriod,
}: {
  moves: HolderMoves
  onPeriod: (period: WibDate) => void
}) {
  const largest = Math.max(
    1,
    ...moves.rail.map(({ counts }) =>
      Math.max(counts.new + counts.up, counts.down + counts.offList)
    )
  )
  const of = KINDS[moves.kind]
  const crossed = moves.lines.filter(
    ({ move }) => move === "new" || move === "off list"
  )
  return (
    <aside className="flex min-w-0 flex-col gap-4">
      <section
        aria-labelledby="rail-days"
        className={cn(kCard, "flex flex-col gap-2")}
      >
        <h2 id="rail-days" className="text-[14px] font-semibold">
          Last {moves.rail.length} {of.units}
        </h2>
        <div
          className="grid items-end gap-1"
          style={{
            gridTemplateColumns: `repeat(${Math.max(moves.rail.length, 1)}, minmax(0, 1fr))`,
          }}
        >
          {moves.rail.map(({ period, counts }) => {
            const ins = counts.new + counts.up
            const outs = counts.down + counts.offList
            return (
              <button
                key={period}
                type="button"
                aria-pressed={period === moves.period}
                aria-label={`${Effect.runSync(of.period(period))}: ${ins} new or up, ${outs} down or off list`}
                onClick={() => onPeriod(period)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border border-transparent py-1.5 aria-pressed:border-border aria-pressed:bg-muted",
                  kFocus
                )}
              >
                <span
                  className="flex items-end gap-0.5"
                  style={{ height: BAR_HEIGHT }}
                >
                  <span
                    className="bg-up w-1.75 rounded-t-xs"
                    style={{ height: (ins / largest) * BAR_HEIGHT }}
                  />
                  <span
                    className="bg-down w-1.75 rounded-t-xs"
                    style={{ height: (outs / largest) * BAR_HEIGHT }}
                  />
                </span>
                <span className="num text-[10.5px] text-muted-foreground">
                  {Effect.runSync(of.tick(period))}
                </span>
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-3 text-[11.5px] text-muted-foreground">
          <span>
            <i
              aria-hidden
              className="bg-up mr-1 inline-block size-2 rounded-xs"
            />
            New and up
          </span>
          <span>
            <i
              aria-hidden
              className="bg-down mr-1 inline-block size-2 rounded-xs"
            />
            Down and off list
          </span>
        </div>
      </section>
      <section
        aria-labelledby="crossed"
        className={cn(kCard, "flex flex-col gap-2")}
      >
        <h2 id="crossed" className="text-[14px] font-semibold">
          Entered or left the list · {crossed.length}
        </h2>
        {crossed.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">
            No holder entered or left.
          </p>
        ) : (
          <ul className="flex max-h-140 flex-col gap-3 overflow-auto">
            {/* Decision: a page renders a list of stored rows through BoundedRows
                (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
            <BoundedRows rows={crossed}>
              {(line) => (
                <li
                  key={`${line.code} ${line.holder}`}
                  className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[12.5px]"
                >
                  <span className="num font-semibold">{line.code}</span>
                  <span className="font-medium">{line.name}</span>
                  <span
                    className={cn(
                      "num col-start-2 text-[11.5px]",
                      line.move === "new" ? "text-up" : "text-down"
                    )}
                  >
                    {line.move === "new"
                      ? `In at ${Effect.runSync(percentOf(line.stake.now ?? 0))}`
                      : `Out ${Effect.runSync(stakeChangeText({ before: line.stake.before }, moves.kind))}`}
                  </span>
                </li>
              )}
            </BoundedRows>
          </ul>
        )}
      </section>
    </aside>
  )
}
