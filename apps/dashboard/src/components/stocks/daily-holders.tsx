// The stock page's Daily holders panel (apinrdw/kumora#677; spec
// apinrdw/kumora#673's prototype, layout D): one parsed above-5% day, picked
// by its own day picker, as the ownership bar and a table of the stock's
// above-5% holders, each against the trading day before by shares with its
// securities accounts listed under it, the day's Off list greyed below them,
// then every earlier holder as Off list since the day it left.
import type { StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { BoundedRows } from "@/components/k/bounded-rows"
import { kCard, kFocus } from "@/components/k/styles"
import {
  BrokerChip,
  Change,
  changeTone,
  lotsChangeText,
  MoveChip,
  offListText,
  OwnershipBar,
  percentChangeText,
  percentOf,
  stakeChangeText,
  stakeSideText,
  THRESHOLDS,
  Trend,
} from "@/components/stocks/holder-cells"
import { TREND_PERIODS } from "@/domain/holdings"
import {
  type SecuritiesAccountLine,
  type DailyHolderLine,
  dailyHolders,
  type HoldersDay,
} from "@/lib/daily-holders"
import { count, lotsOfShares } from "@/lib/format"
import { dayDateLabel } from "@/lib/stock-page-display"
import type { DailyHoldersDay } from "@/server/holdings/stock-page"

export type DailyHoldersProps = {
  code: StockCode
  days: ReadonlyArray<DailyHoldersDay>
  // The URL's `YYYY-MM-DD`; a day the stock doesn't have shows its newest.
  day: string | undefined
  onDay: (dataDate: string) => void
}

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
            threshold={THRESHOLDS.daily}
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
            holders under 5% are not listed. Moves follow shares. Lots: the
            change in shares, a New holder's whole holding in and an Off-list
            holder's last out. Through: the broker codes of the accounts whose
            shares changed, largest change first; Custodian for an account at a
            bank or other custodian that is not an exchange member. Trend: the
            change in lots on each of the last {TREND_PERIODS} trading days up
            to the selected one, green up and red down on a square-root scale,
            blue where the holder entered the list and grey where it left.
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
            {Effect.runSync(dayDateLabel(each))}
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
            <th scope="col" className="text-left">
              Through
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
          {/* Decision: a page renders a list of stored rows through BoundedRows
              (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md) */}
          <BoundedRows rows={Effect.runSync(tableRows(holders))}>
            {(row) =>
              row.kind === "holder" ? (
                <HolderRow key={row.key} line={row.line} compared={compared} />
              ) : row.kind === "account" ? (
                <SecuritiesAccountRow key={row.key} account={row.account} />
              ) : (
                <tr key={row.kind} className="border-b border-border">
                  <td
                    colSpan={7}
                    className="pt-3.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Earlier holders · {row.count}
                  </td>
                </tr>
              )
            }
          </BoundedRows>
        </tbody>
      </table>
    </div>
  )
}

type TableRow =
  | { kind: "holder"; key: string; line: DailyHolderLine }
  | { kind: "account"; key: string; account: SecuritiesAccountLine }
  | { kind: "earlier"; count: number }

// The table's rows in order: each holder of the day, a listed one's
// securities accounts under it, then the earlier holders under their
// heading.
const tableRows = (holders: HoldersDay) =>
  Effect.sync((): ReadonlyArray<TableRow> => [
    ...[...holders.listed, ...holders.offList].flatMap(
      (line): Array<TableRow> => [
        { kind: "holder", key: line.holder, line },
        ...(line.move === "off list"
          ? []
          : line.accounts.map((account, index): TableRow => ({
              kind: "account",
              key: `${line.holder} ${index}`,
              account,
            }))),
      ]
    ),
    ...(holders.history.length > 0
      ? [{ kind: "earlier" as const, count: holders.history.length }]
      : []),
    ...holders.history.map((line): TableRow => ({
      kind: "holder",
      key: line.holder,
      line,
    })),
  ])

const ORIGIN_LABEL = {
  local: "Local",
  foreign: "Foreign",
  mixed: "Mixed",
} as const

// Its stake against the day before, or this day's alone with nothing to
// compare.
const stakeText = (line: DailyHolderLine, compared: boolean) =>
  compared || line.move === "off list"
    ? stakeChangeText(line.stake, "daily")
    : stakeSideText(line.stake.now, "daily")

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
              : Effect.runSync(dayDateLabel(line.offListSince))
          }
          offListTip={Effect.runSync(offListText("daily"))}
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
        <Change value={line.shareChange} text={lotsChangeText} />
      </td>
      <td className="num text-right whitespace-nowrap">
        {Effect.runSync(stakeText(line, compared))}
      </td>
      <td className="num text-right whitespace-nowrap">
        <Change value={line.percentageChange} text={percentChangeText} />
      </td>
      <td data-trend-cell className="text-right">
        <Trend cells={line.trend} name={line.name} periods="trading days" />
      </td>
    </tr>
  )
}

function SecuritiesAccountRow({ account }: { account: SecuritiesAccountLine }) {
  return (
    <tr data-account className="text-[12px] text-muted-foreground">
      <td className="pl-6">
        <div className="flex items-start gap-1.5 text-foreground">
          <BrokerChip broker={account.broker ?? "custodian"} />
          <span>{account.custodian}</span>
        </div>
        <div>{account.name}</div>
      </td>
      {/* Across Move and Through: its broker chip leads its custodian. */}
      <td colSpan={2} className="whitespace-nowrap">
        {ORIGIN_LABEL[account.origin]}
        {account.domicile && ` · ${account.domicile}`}
      </td>
      <td className="num text-right whitespace-nowrap">
        {account.shareChange !== undefined && (
          <span className={Effect.runSync(changeTone(account.shareChange))}>
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
