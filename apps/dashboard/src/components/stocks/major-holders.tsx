// The stock page's Major holders panel (spec apinrdw/kumora#479, "Major
// holders panel"; apinrdw/kumora#474's layout A): one above-1% report month,
// picked by its own month tabs, as layout B's ownership bar and a table of the
// stock's ≥1% holders, each against the report month before, off-list holders
// greyed at the bottom, then every month's holders in a grid.
import type { StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { Fragment, useState } from "react"

import { kCard, kFocus } from "@/components/k/styles"
import { KTooltip } from "@/components/k/tooltip"
import { MonthTabs } from "@/components/stocks/choice"
import { EveryMonth } from "@/components/stocks/every-month"
import { compact, count, MINUS, plain } from "@/lib/format"
import {
  type Change,
  type HolderLine,
  majorHolders,
  type MonthHolders,
} from "@/lib/major-holders"
import { monthLabel, shortMonth } from "@/lib/stock-page-display"
import type { MajorHoldersMonth } from "@/server/holdings/stock-page"

export type MajorHoldersProps = {
  code: StockCode
  months: ReadonlyArray<MajorHoldersMonth>
  // The URL's `YYYY-MM`; a month the stock has no row in shows its newest.
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
          {code} isn't in any IDX above-1% report, so its major holders aren't
          shown.
        </p>
      ) : (
        <>
          <MonthTabs
            code={code}
            months={months.map((each) => ({
              dataDate: each.dataDate,
              held: each.holders.length > 0,
            }))}
            selected={holders.dataDate}
            onMonth={onMonth}
          />
          <OwnershipBar holders={holders} />
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

/** 4110 → `41.10%` */
const percentOf = (hundredths: number) =>
  Effect.map(plain(hundredths / 100, 2), (text) => `${text}%`)

const signOf = (n: number) => Effect.succeed(n > 0 ? "+" : n < 0 ? MINUS : "±")

/** 10 → `+0.10 pp`, 0 → `±0.00 pp` */
const ppText = Effect.fnUntraced(function* (hundredths: number) {
  return `${yield* signOf(hundredths)}${yield* plain(Math.abs(hundredths) / 100, 2)} pp`
})

/** 10,000,000 → `+10 M` */
const sharesText = Effect.fnUntraced(function* (shares: number) {
  return `${yield* signOf(shares)}${yield* compact(shares)}`
})

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

// Each tone's shades, stepped per segment so neighbours of one tone part.
const TONES = {
  gold: ["bg-warning", "bg-warning/70", "bg-warning/85", "bg-warning/55"],
  blue: ["bg-info", "bg-info/70", "bg-info/85", "bg-info/55"],
} as const
const UNDER_1 = "bg-neutral/40"
const LEGEND_TOP = 6

// apinrdw/kumora#474's layout B bar: the month's listed shares split among
// its holders in table order, controllers and affiliates gold, then the
// rest of the 100% as Under 1%.
function OwnershipBar({ holders }: { holders: MonthHolders }) {
  const segments = holders.listed.map((line, index) => {
    const tone = line.controller ? "gold" : "blue"
    return {
      line,
      tone,
      className: TONES[tone][index % TONES[tone].length],
      percent: Effect.runSync(percentOf(line.percentageHundredths)),
    }
  })
  const under = 10_000 - holders.totalHundredths
  const underPercent = Effect.runSync(percentOf(under))
  const more = segments.length - LEGEND_TOP
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label="Ownership of listed shares"
        className="flex h-6 overflow-hidden rounded-md"
      >
        {segments.map(({ line, tone, className, percent }) => (
          <div
            key={line.key}
            title={`${line.name} ${percent}`}
            data-tone={tone}
            style={{ width: `${line.percentageHundredths / 100}%` }}
            className={cn("border-surface min-w-px border-r", className)}
          />
        ))}
        <div
          title={`Holders under 1% ${underPercent}`}
          data-tone="under"
          style={{ width: `${under / 100}%` }}
          className={UNDER_1}
        />
      </div>
      <ul
        aria-label="Ownership legend"
        className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-muted-foreground"
      >
        {segments.slice(0, LEGEND_TOP).map(({ line, className, percent }) => (
          <li key={line.key} className="whitespace-nowrap">
            <Swatch className={className} />
            <span
              className="inline-block max-w-60 truncate align-bottom"
              title={line.name}
            >
              {line.name}
            </span>{" "}
            {percent}
          </li>
        ))}
        {more > 0 && <li>+{more} more</li>}
        <li className="whitespace-nowrap">
          <Swatch className={UNDER_1} />
          Under 1% {underPercent}
        </li>
        <li className="whitespace-nowrap">
          <Swatch className={TONES.gold[0]} />
          Gold = controller or affiliate
        </li>
      </ul>
    </div>
  )
}

function Swatch({ className }: { className: string }) {
  return (
    <i
      aria-hidden
      className={cn(
        "mr-1.5 inline-block size-2.5 rounded-xs align-[-1px]",
        className
      )}
    />
  )
}

const CHIP: Record<Change, { label: string; className: string }> = {
  new: { label: "New", className: "bg-info/15 text-info" },
  up: { label: "Up", className: "bg-up/15 text-up" },
  down: { label: "Down", className: "bg-down/15 text-down" },
  unchanged: { label: "Unchanged", className: "text-muted-foreground" },
  "off list": { label: "Off list", className: "bg-neutral/15 text-neutral" },
}

const CHIP_CLASS =
  "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap"

// Off list's chip is a button, so its tooltip opens on focus too.
function ChangeChip({ change }: { change: Change | undefined }) {
  if (change === undefined) return null
  const { label, className } = CHIP[change]
  return change === "off list" ? (
    <KTooltip content="Sold out or fell below 1%">
      <button type="button" className={cn(CHIP_CLASS, kFocus, className)}>
        {label}
      </button>
    </KTooltip>
  ) : (
    <span className={cn(CHIP_CLASS, className)}>{label}</span>
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
              Shares
            </th>
            <th scope="col" className="text-right">
              In scrip
            </th>
          </tr>
        </thead>
        <tbody>
          {[...holders.listed, ...holders.offList].map((line) => (
            <HolderRow
              key={line.key}
              line={line}
              open={open.has(line.key)}
              onToggle={() => toggle(line.key)}
            />
          ))}
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
                    {row.name} · {Effect.runSync(compact(row.total))} ·{" "}
                    {Effect.runSync(percentOf(row.percentageHundredths))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </th>
      <td>
        <ChangeChip change={line.change} />
      </td>
      <td className="num text-right whitespace-nowrap">
        <div>
          {off ? "—" : Effect.runSync(percentOf(line.percentageHundredths))}
        </div>
        {off ? (
          <div>was {Effect.runSync(percentOf(line.percentageHundredths))}</div>
        ) : (
          <Delta value={line.ppChange} text={ppText} />
        )}
      </td>
      <td className="num text-right whitespace-nowrap">
        <div>{off ? "—" : Effect.runSync(compact(line.total))}</div>
        {!off && <Delta value={line.shareChange} text={sharesText} />}
      </td>
      <td className="num text-right whitespace-nowrap">
        {off || line.inScrip === undefined
          ? "—"
          : `${Math.round(line.inScrip * 100)}%`}
      </td>
    </tr>
  )
}

function Delta({
  value,
  text,
}: {
  value: number | undefined
  text: (value: number) => Effect.Effect<string>
}) {
  if (value === undefined) return null
  return (
    <div
      className={cn(
        "text-[12px]",
        value > 0
          ? "text-up"
          : value < 0
            ? "text-down"
            : "text-muted-foreground"
      )}
    >
      {Effect.runSync(text(value))}
    </div>
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
