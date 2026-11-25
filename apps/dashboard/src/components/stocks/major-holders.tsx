// The stock page's Major holders panel (spec apinrdw/kumora#479, "Major
// holders panel"; apinrdw/kumora#474's layout A): one above-1% report month,
// picked by its own month tabs, as layout B's ownership bar and a table of the
// stock's ≥1% holders, each against the report month before, off-list holders
// greyed below them, then every earlier holder as Off list since the month it
// left, then every month's holders in a grid.
import type { StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { Fragment, useState } from "react"

import { kCard, kFocus } from "@/components/k/styles"
import { MonthTabs } from "@/components/stocks/choice"
import { EveryMonth } from "@/components/stocks/every-month"
import {
  Delta,
  lotsChangeText,
  MoveChip,
  OwnershipBar,
  percentChangeText,
  percentOf,
} from "@/components/stocks/holder-cells"
import { count, lotsOfShares } from "@/lib/format"
import {
  type HolderLine,
  majorHolders,
  type MonthHolders,
  monthReports,
} from "@/lib/major-holders"
import { monthLabel, shortMonth } from "@/lib/stock-page-display"
import type { MajorHoldersMonth } from "@/server/holdings/stock-page"

export type MajorHoldersProps = {
  code: StockCode
  months: ReadonlyArray<MajorHoldersMonth>
  // The URL's `YYYY-MM`; a month with no report the stock is in shows its
  // newest.
  month: string | undefined
  onMonth: (dataDate: string) => void
}

export function MajorHolders({
  code,
  months,
  month,
  onMonth,
}: MajorHoldersProps) {
  const holders = Effect.runSync(majorHolders(months, month))
  return (
    <section
      aria-labelledby="major-holders"
      className={cn(kCard, "flex flex-col gap-3")}
    >
      <div className="flex flex-col gap-1">
        <h2 id="major-holders" className="text-[15px] font-semibold">
          Major holders
        </h2>
        {holders && (
          <p className="text-[13px] text-muted-foreground">
            {Effect.runSync(summary(code, holders))}
          </p>
        )}
      </div>
      {holders === undefined ? (
        <p className="text-muted-foreground">
          {code} isn't in any IDX above-1% report, so its ≥1% holders aren't
          shown.
        </p>
      ) : (
        <>
          <MonthTabs
            code={code}
            months={Effect.runSync(monthReports(months))}
            selected={holders.dataDate}
            onMonth={onMonth}
          />
          <MonthBar holders={holders} />
          <HoldersTable holders={holders} />
          <p className="text-[12px] text-muted-foreground">
            Percent of listed shares, scrip included, as IDX publishes it.
            Holders under 1% are not listed.
          </p>
          <EveryMonth months={months} selected={holders.dataDate} />
        </>
      )}
    </section>
  )
}

// The month's line: its holders and their %, then the changes against the
// month before, or why there are none.
const summary = Effect.fnUntraced(function* (
  code: StockCode,
  holders: MonthHolders
) {
  const held = `${yield* count(holders.listed.length, "holder holds", "holders hold")} ${yield* percentOf(holders.totalHundredths)} of listed shares`
  const { comparison, counts } = holders
  if (comparison.kind === "first")
    return `${held} · First month reported, nothing to compare`
  const label = yield* monthLabel(comparison.dataDate)
  if (comparison.kind === "gap" || counts === undefined)
    return `${held} · ${code} isn't in ${label}'s report, nothing to compare`
  return `${held} · vs ${label}: ${counts.new} new, ${counts.up} up, ${counts.down} down, ${counts.offList} off list`
})

// The month's holders as the bar's segments, in table order.
function MonthBar({ holders }: { holders: MonthHolders }) {
  return (
    <OwnershipBar
      segments={holders.listed.map((line) => ({
        key: line.holder,
        name: line.name,
        hundredths: line.percentageHundredths,
        shares: line.total,
        gold: line.controller !== undefined,
      }))}
      threshold="1%"
      controllers
    />
  )
}

function ChangeChip({ line }: { line: HolderLine }) {
  return (
    <MoveChip
      move={line.change}
      since={
        line.offListSince === undefined
          ? undefined
          : Effect.runSync(monthLabel(line.offListSince))
      }
      offListTip="Sold out or fell below 1%"
    />
  )
}

function HoldersTable({ holders }: { holders: MonthHolders }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setOpen((keys) => {
      const next = new Set(keys)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const { comparison } = holders
  return (
    <div className="overflow-x-auto">
      <table
        aria-label="Major holders"
        className="w-full text-[13px] [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_th]:px-2 [&_th]:py-1.5 [&_th]:align-top [&_tr]:border-b [&_tr]:border-border"
      >
        <thead className="[&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground">
          <tr>
            <th scope="col" className="text-left">
              Holder
            </th>
            <th scope="col" className="text-left">
              vs{" "}
              {comparison.kind === "first"
                ? "—"
                : Effect.runSync(shortMonth(comparison.dataDate))}
            </th>
            <th scope="col" className="text-right">
              % of listed
            </th>
            <th scope="col" className="text-right">
              Lots
            </th>
            <th scope="col" className="text-right">
              In scrip
            </th>
          </tr>
        </thead>
        <tbody>
          {[...holders.listed, ...holders.offList, ...holders.history].map(
            (line) => (
              <HolderRow
                key={line.holder}
                line={line}
                open={open.has(line.holder)}
                onToggle={() => toggle(line.holder)}
              />
            )
          )}
        </tbody>
      </table>
    </div>
  )
}

function HolderRow({
  line,
  open,
  onToggle,
}: {
  line: HolderLine
  open: boolean
  onToggle: () => void
}) {
  const off = line.change === "off list"
  return (
    <tr
      data-off-list={off || undefined}
      className={cn(off && "text-muted-foreground")}
    >
      <th scope="row" className="text-left font-normal">
        <div data-holder-name className="font-medium">
          {line.name}
        </div>
        <HolderMeta line={line} />
        {line.rows.length > 1 && (
          <div>
            <button
              type="button"
              aria-expanded={open}
              onClick={onToggle}
              className={cn("text-info text-[12px]", kFocus)}
            >
              {line.rows.length} rows in the report
            </button>
            {open && (
              <ul className="mt-1 flex flex-col gap-0.5 text-[12px] text-muted-foreground">
                {line.rows.map((row, index) => (
                  <li key={index}>
                    {row.name} · {Effect.runSync(lotsOfShares(row.total))} lots
                    · {Effect.runSync(percentOf(row.percentageHundredths))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </th>
      <td>
        <ChangeChip line={line} />
      </td>
      <td className="num text-right whitespace-nowrap">
        <div>
          {off ? "—" : Effect.runSync(percentOf(line.percentageHundredths))}
        </div>
        {off ? (
          <div>was {Effect.runSync(percentOf(line.percentageHundredths))}</div>
        ) : (
          <Delta value={line.percentageChange} text={percentChangeText} />
        )}
      </td>
      <td className="num text-right whitespace-nowrap">
        <div>{off ? "—" : Effect.runSync(lotsOfShares(line.total))}</div>
        {!off && <Delta value={line.shareChange} text={lotsChangeText} />}
      </td>
      <td className="num text-right whitespace-nowrap">
        {off || line.inScrip === undefined
          ? "—"
          : `${Math.round(line.inScrip * 100)}%`}
      </td>
    </tr>
  )
}

const ORIGIN_LABEL = { local: "Local", foreign: "Foreign" } as const

// The holder's controller badge, classification or type, origin, and
// domicile when foreign.
function HolderMeta({ line }: { line: HolderLine }) {
  const parts = [
    line.controller && (
      <span
        key="controller"
        className="bg-warning/15 text-warning rounded-xs px-1.5 font-medium"
      >
        {line.controller === "controller"
          ? "Controller"
          : "Affiliate of controller"}
      </span>
    ),
    line.label && <span key="label">{line.label}</span>,
    <span key="origin">
      {line.origin === undefined
        ? "Scrip account, origin unknown"
        : ORIGIN_LABEL[line.origin]}
    </span>,
    line.origin === "foreign" && line.domicile && (
      <span key="domicile">{line.domicile}</span>
    ),
  ].filter(Boolean)
  return (
    <div
      data-holder-meta
      className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground"
    >
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden>·</span>}
          {part}
        </Fragment>
      ))}
    </div>
  )
}
