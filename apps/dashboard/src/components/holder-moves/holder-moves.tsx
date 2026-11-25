// The Holder moves page (apinrdw/kumora#679, #680; spec apinrdw/kumora#673's
// prototype): every above-5% holder that moved on one trading day (Daily),
// or ≥1% holder in one above-1% report month (Monthly), across the market,
// filtered by move and searched, beside a rail of the last periods' counts
// and the holders that entered or left the list. A row opens its stock's
// Daily holders at that day, or Major holders in that month.
import { Link } from "@tanstack/react-router"
import { WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { kCard, kFocus } from "@/components/k/styles"
import {
  BrokerChip,
  changeTone,
  lotsChangeText,
  MoveChip,
  percentChangeText,
  percentOf,
  Trend,
} from "@/components/stocks/holder-cells"
import type { MoveKind } from "@/domain/holdings"
import { count } from "@/lib/format"
import {
  type HolderMoves,
  type MoveCounts,
  type MoveFilter,
  type MoveLine,
  visibleLines,
} from "@/lib/holder-moves"
import { dayDateLabel, monthLabel } from "@/lib/stock-page-display"

export type HolderMovesPageProps = {
  kind: MoveKind
  // Undefined when no period of `kind` is parsed.
  moves: HolderMoves | undefined
  filter: MoveFilter
  search: string
  onFilter: (filter: MoveFilter) => void
  onSearch: (search: string) => void
  onPeriod: (period: string) => void
  onKind: (kind: MoveKind) => void
}

const percentText = (hundredths: number) =>
  Effect.runSync(percentOf(hundredths))

// What differs between a trading day's above-5% moves and a month's ≥1%.
const KINDS: Record<
  MoveKind,
  {
    readonly label: string
    readonly threshold: string
    readonly under: string
    readonly period: (date: string) => Effect.Effect<string>
    // The rail's tick under a period's bars.
    readonly tick: (date: string) => string
    readonly unit: string
    readonly units: string
    // How the headline puts the period: "on 20 Nov 2026", "in Oct 2026".
    readonly at: string
    readonly offListTip: string
    readonly note: string
  }
> = {
  daily: {
    label: "Daily",
    threshold: "5%",
    under: "under 5%",
    period: dayDateLabel,
    tick: (date) => date.slice(8, 10),
    unit: "day",
    units: "trading days",
    at: "on",
    offListTip: "Sold out or fell below 5%; the report can't tell which",
    note: "Percent of listed shares as IDX publishes it each trading day; holders under 5% are not listed. Moves follow shares, against the parsed day before. Through: the broker codes of the accounts whose shares changed, largest change first; Custodian for an account at a bank or other custodian that is not an exchange member. Trend: the change in lots on each of the last 20 trading days up to the selected one, blue where the holder entered the list and grey where it left.",
  },
  monthly: {
    label: "Monthly",
    threshold: "1%",
    under: "under 1%",
    period: monthLabel,
    tick: (date) => Effect.runSync(monthLabel(date)).slice(0, 3),
    unit: "month",
    units: "months",
    at: "in",
    offListTip: "Sold out or fell below 1%; the report can't tell which",
    note: "Percent of listed shares as IDX publishes it each month; holders under 1% are not listed. Moves follow the change in percent against the report month before, as Major holders' do. Lots: the change in total holding, scrip included. Trend: the change in lots in each of the last 20 report months up to the selected one, blue where the holder entered the list and grey where it left.",
  },
}

const periodText = (kind: MoveKind, date: string) =>
  Effect.runSync(KINDS[kind].period(date))

const FILTERS: ReadonlyArray<{
  filter: MoveFilter
  label: string
  of: (counts: MoveCounts) => number
}> = [
  {
    filter: "all",
    label: "All",
    of: (counts) => counts.new + counts.up + counts.down + counts.offList,
  },
  { filter: "new", label: "New", of: (counts) => counts.new },
  { filter: "up", label: "Up", of: (counts) => counts.up },
  { filter: "down", label: "Down", of: (counts) => counts.down },
  { filter: "off list", label: "Off list", of: (counts) => counts.offList },
]

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
            ? `No ${KINDS[kind].unit} of IDX's above-${KINDS[kind].threshold} report is parsed yet.`
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
                {FILTERS.map((each) => (
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
  const moved = yield* count(
    moves.lines.length,
    `holder above ${of.threshold} moved`,
    `holders above ${of.threshold} moved`
  )
  const stocks = yield* count(moves.stockCount, "stock", "stocks")
  return `${moved} across ${stocks} ${of.at} ${period}, against ${yield* of.period(moves.against)}.`
})

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

// A month's moves have no Through: the above-1% report lists no accounts.
const columnsOf = (kind: MoveKind) =>
  kind === "daily" ? COLUMNS : COLUMNS.filter(([label]) => label !== "Through")

function MovesTable({
  moves,
  lines,
}: {
  moves: HolderMoves
  lines: ReadonlyArray<MoveLine>
}) {
  const of = KINDS[moves.kind]
  const columns = columnsOf(moves.kind)
  const empty =
    moves.against === undefined
      ? `Nothing to compare on the first ${of.unit} parsed.`
      : moves.lines.length === 0
        ? `No holder above ${of.threshold} moved ${of.at} ${periodText(moves.kind, moves.period)}.`
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
            lines.map((line) => (
              <MoveRow
                key={`${line.code} ${line.holder}`}
                line={line}
                kind={moves.kind}
                period={moves.period}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

const stakeText = (kind: MoveKind, { stake }: MoveLine) => {
  const { under } = KINDS[kind]
  return `${stake.before === undefined ? under : percentText(stake.before)} → ${stake.now === undefined ? under : percentText(stake.now)}`
}

function MoveRow({
  line,
  kind,
  period,
}: {
  line: MoveLine
  kind: MoveKind
  period: string
}) {
  return (
    <tr data-move className="border-t border-border">
      <td className="whitespace-nowrap">
        <Link
          to="/stocks/$code"
          params={{ code: line.code }}
          search={
            kind === "daily"
              ? { holdersDay: WibDate.make(period) }
              : { holdersMonth: period.slice(0, 7) }
          }
          hash={kind === "daily" ? "daily-holders" : "major-holders"}
          aria-label={`${line.code} ${line.issuerName}`}
          className={cn("rounded-xs hover:underline", kFocus)}
        >
          <span className="num font-semibold">{line.code}</span>
          <span className="ml-2 text-[12px] text-muted-foreground">
            {line.issuerName}
          </span>
        </Link>
      </td>
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
      <td>
        <MoveChip
          move={line.move}
          since={undefined}
          offListTip={KINDS[kind].offListTip}
        />
      </td>
      {kind === "daily" && (
        <td data-through>
          <div className="flex flex-wrap gap-1">
            {line.through.map((broker) => (
              <BrokerChip key={broker} broker={broker} />
            ))}
          </div>
        </td>
      )}
      <td className="num text-right whitespace-nowrap">
        {line.shareChange === undefined ? (
          "—"
        ) : (
          <span className={changeTone(line.shareChange)}>
            {Effect.runSync(lotsChangeText(line.shareChange))}
          </span>
        )}
      </td>
      <td className="num text-right whitespace-nowrap">
        {stakeText(kind, line)}
      </td>
      <td className="num text-right whitespace-nowrap">
        {line.percentageChange === undefined ? (
          "—"
        ) : (
          <span className={changeTone(line.percentageChange)}>
            {Effect.runSync(percentChangeText(line.percentageChange))}
          </span>
        )}
      </td>
      <td className="text-right">
        <Trend
          cells={line.trend}
          name={line.name}
          periods={KINDS[kind].units}
        />
      </td>
    </tr>
  )
}

const BAR_HEIGHT = 64

function Rail({
  moves,
  onPeriod,
}: {
  moves: HolderMoves
  onPeriod: (period: string) => void
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
                aria-label={`${periodText(moves.kind, period)}: ${ins} new or up, ${outs} down or off list`}
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
                  {of.tick(period)}
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
            {crossed.map((line) => (
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
                    ? `In at ${percentText(line.stake.now ?? 0)}`
                    : `Out ${percentText(line.stake.before ?? 0)} → ${of.under}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
