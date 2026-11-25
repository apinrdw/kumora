// The Holder moves page (apinrdw/kumora#679; spec apinrdw/kumora#673's
// prototype, Daily view): every above-5% holder that moved on one trading
// day across the market, filtered by move and searched, beside a rail of the
// last trading days' counts and the holders that entered or left the list.
// A row opens its stock's Daily holders at that day.
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
import { count } from "@/lib/format"
import {
  type HolderMoves,
  type MoveCounts,
  type MoveFilter,
  type MoveLine,
  visibleLines,
} from "@/lib/holder-moves"
import { dayDateLabel } from "@/lib/stock-page-display"

export type HolderMovesPageProps = {
  // Undefined when no day is parsed.
  moves: HolderMoves | undefined
  filter: MoveFilter
  search: string
  onFilter: (filter: MoveFilter) => void
  onSearch: (search: string) => void
  onPeriod: (period: string) => void
}

const dayText = (date: string) => Effect.runSync(dayDateLabel(date))
const percentText = (hundredths: number) =>
  Effect.runSync(percentOf(hundredths))

const UNDER = "under 5%"

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
  moves,
  filter,
  search,
  onFilter,
  onSearch,
  onPeriod,
}: HolderMovesPageProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-semibold tracking-tight">
          Holder moves
        </h1>
        <p className="text-[13px] text-muted-foreground">
          {moves === undefined
            ? "No day of IDX's above-5% report is parsed yet."
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
              Percent of listed shares as IDX publishes it each trading day;
              holders under 5% are not listed. Moves follow shares, against the
              parsed day before. Through: the broker codes of the accounts whose
              shares changed, largest change first; Custodian for an account at
              a bank or other custodian that is not an exchange member. Trend:
              the change in lots on each of the last 20 trading days up to the
              selected one, blue where the holder entered the list and grey
              where it left.
            </p>
          </section>
          <Rail moves={moves} onPeriod={onPeriod} />
        </div>
      )}
    </div>
  )
}

const headline = Effect.fnUntraced(function* (moves: HolderMoves) {
  const day = yield* dayDateLabel(moves.period)
  if (moves.against === undefined)
    return `${day} is the first day parsed, so nothing to compare it with.`
  const moved = yield* count(
    moves.lines.length,
    "holder above 5% moved",
    "holders above 5% moved"
  )
  const stocks = yield* count(moves.stockCount, "stock", "stocks")
  return `${moved} across ${stocks} on ${day}, against ${yield* dayDateLabel(moves.against)}.`
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

function MovesTable({
  moves,
  lines,
}: {
  moves: HolderMoves
  lines: ReadonlyArray<MoveLine>
}) {
  const empty =
    moves.against === undefined
      ? "Nothing to compare on the first day parsed."
      : moves.lines.length === 0
        ? `No holder above 5% moved on ${dayText(moves.period)}.`
        : "No holder matches. Clear the search or pick All."
  return (
    <div className="overflow-x-auto">
      <table
        aria-label="Holder moves"
        className="w-full min-w-245 text-[13px] [&_td]:px-2 [&_td]:py-2 [&_td]:align-top [&_th]:px-2 [&_th]:py-2 [&_th]:align-top"
      >
        <thead className="border-b border-border [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground">
          <tr>
            {COLUMNS.map(([label, align]) => (
              <th key={label} scope="col" className={align}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="text-muted-foreground">
                {empty}
              </td>
            </tr>
          ) : (
            lines.map((line) => (
              <MoveRow
                key={`${line.code} ${line.holder}`}
                line={line}
                period={moves.period}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

const stakeText = ({ stake }: MoveLine) =>
  `${stake.before === undefined ? UNDER : percentText(stake.before)} → ${stake.now === undefined ? UNDER : percentText(stake.now)}`

function MoveRow({ line, period }: { line: MoveLine; period: string }) {
  return (
    <tr data-move className="border-t border-border">
      <td className="whitespace-nowrap">
        <Link
          to="/stocks/$code"
          params={{ code: line.code }}
          search={{ holdersDay: WibDate.make(period) }}
          hash="daily-holders"
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
          offListTip="Sold out or fell below 5%; the report can't tell which"
        />
      </td>
      <td data-through>
        <div className="flex flex-wrap gap-1">
          {line.through.map((broker) => (
            <BrokerChip key={broker} broker={broker} />
          ))}
        </div>
      </td>
      <td className="num text-right whitespace-nowrap">
        {line.shareChange === undefined ? (
          "—"
        ) : (
          <span className={changeTone(line.shareChange)}>
            {Effect.runSync(lotsChangeText(line.shareChange))}
          </span>
        )}
      </td>
      <td className="num text-right whitespace-nowrap">{stakeText(line)}</td>
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
        <Trend cells={line.trend} name={line.name} />
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
          Last {moves.rail.length} trading days
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
                aria-label={`${dayText(period)}: ${ins} new or up, ${outs} down or off list`}
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
                  {period.slice(8, 10)}
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
                    : `Out ${percentText(line.stake.before ?? 0)} → ${UNDER}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
