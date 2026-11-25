// The stock page's Daily holders panel (apinrdw/kumora#677; spec
// apinrdw/kumora#673's prototype, layout D): one parsed above-5% day, picked
// by its own day picker, as the ownership bar and a table of the stock's
// above-5% holders, each against the trading day before by shares with its
// accounts listed under it, the day's Off list greyed below them, then every
// earlier holder as Off list since the day it left.
import type { StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { Fragment } from "react"

import { kCard, kFocus } from "@/components/k/styles"
import {
  changeTone,
  lotsChangeText,
  MoveChip,
  OwnershipBar,
  percentChangeText,
  percentOf,
} from "@/components/stocks/holder-cells"
import {
  type AccountLine,
  type DailyHolderLine,
  dailyHolders,
  type HoldersDay,
} from "@/lib/daily-holders"
import { count, lotsOfShares } from "@/lib/format"
import type { TrendCell } from "@/lib/holder-identity"
import { dayDateLabel } from "@/lib/stock-page-display"
import type { DailyHoldersDay } from "@/server/holdings/stock-page"

export type DailyHoldersProps = {
  code: StockCode
  days: ReadonlyArray<DailyHoldersDay>
  // The URL's `YYYY-MM-DD`; a day the stock doesn't have shows its newest.
  day: string | undefined
  onDay: (dataDate: string) => void
}

const dayText = (date: string) => Effect.runSync(dayDateLabel(date))

export function DailyHolders({ code, days, day, onDay }: DailyHoldersProps) {
  const holders = Effect.runSync(dailyHolders(days, day))
  return (
    <section
      aria-labelledby="daily-holders"
      className={cn(kCard, "flex flex-col gap-3")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="daily-holders" className="text-[15px] font-semibold">
            Daily holders
          </h2>
          {holders && (
            <p className="text-[13px] text-muted-foreground">
              {Effect.runSync(summary(holders))}
            </p>
          )}
        </div>
        {holders && <DayPicker holders={holders} onDay={onDay} />}
      </div>
      {holders === undefined ? (
        <p className="text-muted-foreground">
          {code} has no holder above 5% on any day parsed from IDX's daily
          report.
        </p>
      ) : (
        <>
          <OwnershipBar
            segments={holders.listed.map((line) => ({
              key: line.holder,
              name: line.name,
              hundredths: line.stake.now ?? 0,
              shares: line.shares,
              gold: false,
            }))}
            threshold="5%"
            restShares={
              holders.listedShares === undefined
                ? undefined
                : holders.listedShares -
                  holders.listed.reduce((sum, { shares }) => sum + shares, 0)
            }
            controllers={false}
          />
          <HoldersTable holders={holders} />
          <p className="text-[12px] text-muted-foreground">
            Percent of listed shares as IDX publishes it each trading day;
            holders under 5% are not listed. Moves follow shares. Trend: the
            change in lots on each of the last 20 trading days up to the
            selected one, green up and red down on a square-root scale, blue
            where the holder entered the list and grey where it left.
          </p>
        </>
      )}
    </section>
  )
}

// The day's line: its holders and their %, then the moves against the day
// before, or why there are none.
const summary = Effect.fnUntraced(function* (holders: HoldersDay) {
  const held = `${yield* count(holders.listed.length, "holder holds", "holders hold")} ${yield* percentOf(holders.totalHundredths)} of listed shares`
  const { against, counts } = holders
  if (against === undefined || counts === undefined)
    return `${held} · First day parsed, nothing to compare`
  return `${held} · vs ${yield* dayDateLabel(against)}: ${counts.new} new, ${counts.up} up, ${counts.down} down, ${counts.offList} off list`
})

const ICON_BUTTON = cn(
  "bg-surface grid size-7.5 place-items-center rounded-md border border-border text-[14px] disabled:cursor-default disabled:opacity-35",
  kFocus
)

function DayPicker({
  holders,
  onDay,
}: {
  holders: HoldersDay
  onDay: (dataDate: string) => void
}) {
  const at = holders.days.indexOf(holders.dataDate)
  const previous = holders.days[at - 1]
  const next = holders.days[at + 1]
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="Previous trading day"
        disabled={previous === undefined}
        onClick={() => previous && onDay(previous)}
        className={ICON_BUTTON}
      >
        ‹
      </button>
      <select
        aria-label="Trading day"
        value={holders.dataDate}
        onChange={(event) => onDay(event.target.value)}
        className={cn(
          "num bg-surface rounded-md border border-border px-2 py-1 text-[13px] font-semibold",
          kFocus
        )}
      >
        {holders.days.map((each) => (
          <option key={each} value={each}>
            {dayText(each)}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Next trading day"
        disabled={next === undefined}
        onClick={() => next && onDay(next)}
        className={ICON_BUTTON}
      >
        ›
      </button>
    </div>
  )
}

function HoldersTable({ holders }: { holders: HoldersDay }) {
  const compared = holders.against !== undefined
  return (
    <div className="overflow-x-auto">
      <table
        aria-label="Daily holders"
        className="w-full min-w-160 text-[13px] [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_th]:px-2 [&_th]:py-1.5 [&_th]:align-top"
      >
        <thead className="border-b border-border [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground">
          <tr>
            <th scope="col" className="text-left">
              Holder
            </th>
            <th scope="col" className="text-left">
              Move
            </th>
            <th scope="col" className="text-right">
              Lots
            </th>
            <th scope="col" className="text-right">
              Stake
            </th>
            <th scope="col" className="text-right">
              Change
            </th>
            <th scope="col" className="text-right">
              Trend
            </th>
          </tr>
        </thead>
        <tbody>
          {[...holders.listed, ...holders.offList].map((line) => (
            <Fragment key={line.holder}>
              <HolderRow line={line} compared={compared} />
              {line.move !== "off list" &&
                line.accounts.map((account, index) => (
                  <AccountRow key={index} account={account} />
                ))}
            </Fragment>
          ))}
          {holders.history.length > 0 && (
            <tr className="border-b border-border">
              <td
                colSpan={6}
                className="pt-3.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
              >
                Earlier holders · {holders.history.length}
              </td>
            </tr>
          )}
          {holders.history.map((line) => (
            <HolderRow key={line.holder} line={line} compared={compared} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

const ORIGIN_LABEL = {
  local: "Local",
  foreign: "Foreign",
  mixed: "Mixed",
} as const

const UNDER_5 = "under 5%"

const stakeText = (line: DailyHolderLine, compared: boolean) => {
  const now =
    line.stake.now === undefined
      ? UNDER_5
      : Effect.runSync(percentOf(line.stake.now))
  if (!compared && line.move !== "off list") return now
  const before =
    line.stake.before === undefined
      ? UNDER_5
      : Effect.runSync(percentOf(line.stake.before))
  return `${before} → ${now}`
}

function HolderRow({
  line,
  compared,
}: {
  line: DailyHolderLine
  compared: boolean
}) {
  const off = line.move === "off list"
  return (
    <tr
      data-holder
      data-off-list={off || undefined}
      className={cn("border-t border-border", off && "text-muted-foreground")}
    >
      <th scope="row" className="min-w-56 text-left font-normal">
        <div data-holder-name className={cn(!off && "font-medium")}>
          {line.name}
        </div>
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
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="rounded-xs border border-border px-1.5 text-[11px] font-semibold">
            {ORIGIN_LABEL[line.origin]}
          </span>
          {Effect.runSync(count(line.accounts.length, "account", "accounts"))}
        </div>
      </th>
      <td>
        <MoveChip
          move={line.move}
          since={
            line.offListSince === undefined
              ? undefined
              : dayText(line.offListSince)
          }
          offListTip="Sold out or fell below 5%; the report can't tell which"
        />
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
      <td className="num text-right whitespace-nowrap">
        {stakeText(line, compared)}
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
      <td data-trend-cell className="text-right">
        <Trend cells={line.trend} name={line.name} />
      </td>
    </tr>
  )
}

function AccountRow({ account }: { account: AccountLine }) {
  return (
    <tr data-account className="text-[12px] text-muted-foreground">
      <td className="pl-6">
        <div className="text-foreground">{account.custodian}</div>
        <div>{account.name}</div>
      </td>
      <td className="whitespace-nowrap">
        {ORIGIN_LABEL[account.origin]}
        {account.domicile && ` · ${account.domicile}`}
      </td>
      <td className="num text-right whitespace-nowrap">
        {account.shareChange !== undefined && (
          <span className={changeTone(account.shareChange)}>
            {Effect.runSync(lotsChangeText(account.shareChange))}
          </span>
        )}
      </td>
      <td className="num text-right whitespace-nowrap">
        {Effect.runSync(lotsOfShares(account.shares))} lots
      </td>
    </tr>
  )
}

const TREND_SLOTS = 20
const TREND_WIDTH = 160
const TREND_HEIGHT = 26

// One bar per trading day, the selected day last and shaded: a change in
// shares up or down from the midline on a square-root scale, a full bar
// where the holder entered (blue) or left (grey) the list.
function Trend({
  cells,
  name,
}: {
  cells: ReadonlyArray<TrendCell>
  name: string
}) {
  const slot = TREND_WIDTH / TREND_SLOTS
  const offset = TREND_SLOTS - cells.length
  const middle = TREND_HEIGHT / 2
  const largest = Math.max(
    1,
    ...cells.map((cell) =>
      typeof cell === "number" ? Math.sqrt(Math.abs(cell)) : 0
    )
  )
  return (
    <svg
      width={TREND_WIDTH}
      height={TREND_HEIGHT}
      viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
      role="img"
      aria-label={`${name}: change in lots on each of the last ${cells.length} trading days`}
      className="ml-auto block"
    >
      <line
        x1={0}
        x2={TREND_WIDTH}
        y1={middle}
        y2={middle}
        className="stroke-border"
        strokeDasharray="2 2"
      />
      {cells.map((cell, index) => {
        if (cell === null || cell === 0) return null
        const x = (offset + index) * slot + 1
        const width = Math.max(slot - 2, 1.4)
        if (typeof cell === "string")
          return (
            <rect
              key={index}
              data-cell={cell}
              x={x}
              y={1}
              width={width}
              height={TREND_HEIGHT - 2}
              opacity={0.8}
              className={cell === "in" ? "fill-info" : "fill-neutral"}
            />
          )
        const height = Math.max(
          2.5,
          (Math.sqrt(Math.abs(cell)) / largest) * (middle - 1)
        )
        return (
          <rect
            key={index}
            data-cell={cell > 0 ? "up" : "down"}
            x={x}
            y={cell > 0 ? middle - height : middle}
            width={width}
            height={height}
            className={cell > 0 ? "fill-up" : "fill-down"}
          />
        )
      })}
      <rect
        x={(TREND_SLOTS - 1) * slot}
        y={0}
        width={slot}
        height={TREND_HEIGHT}
        className="fill-foreground"
        opacity={0.1}
      />
    </svg>
  )
}
