// The stock page's Shareholders composition panel (spec apinrdw/kumora#363,
// stories 13–27; prototype variant D): month tabs, an origin switch, the
// totals, and one row per KSEI investor type or investor classification.
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { type ReactNode, useState } from "react"

import { KChip } from "@/components/k/chip"
import { kCard, kFocus } from "@/components/k/styles"
import { KTooltip } from "@/components/k/tooltip"
import type { KseiType } from "@/domain/holdings"
import { compact, plain } from "@/lib/format"
import {
  type Composition,
  composition,
  type Level,
} from "@/lib/stock-composition"
import type { PanelOrigin } from "@/lib/stock-search"
import type { StockPage } from "@/server/holdings/stock-page"

const NOT_SPLIT = "not reported before Sep 2026"

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** `2026-10-30` → `Oct 2026` */
const monthLabel = (dataDate: string) =>
  `${MONTHS[Number(dataDate.slice(5, 7)) - 1]} ${dataDate.slice(0, 4)}`

const TYPE_COLOR: Record<KseiType, string> = {
  ID: "var(--investor-id)",
  CP: "var(--investor-cp)",
  MF: "var(--investor-mf)",
  IB: "var(--investor-ib)",
  IS: "var(--investor-is)",
  SC: "var(--investor-sc)",
  PF: "var(--investor-pf)",
  FD: "var(--investor-fd)",
  OT: "var(--investor-ot)",
}

const ORIGINS: ReadonlyArray<{ value: PanelOrigin; label: string }> = [
  { value: "all", label: "All scripless" },
  { value: "local", label: "Local" },
  { value: "foreign", label: "Foreign" },
]

const percent = (share: number) => Effect.runSync(plain(share * 100, 2)) + "%"

type Composed = NonNullable<StockPage["composition"]>

export type ShareholdersCompositionProps = {
  page: StockPage & { readonly composition: Composed }
  origin: PanelOrigin
  onMonth: (dataDate: string) => void
  onOrigin: (origin: PanelOrigin) => void
}

export function ShareholdersComposition({
  page,
  origin,
  onMonth,
  onOrigin,
}: ShareholdersCompositionProps) {
  const [level, setLevel] = useState<Level>("types")
  const { month, previous } = page.composition
  // An unsplit month shows all scripless; the URL keeps the origin for a
  // split month picked next.
  const shown = month.split ? origin : "all"
  const rows = Effect.runSync(composition(month, previous, shown, level))
  return (
    <section
      aria-labelledby="shareholders-composition"
      className={cn(kCard, "flex flex-col gap-3")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="shareholders-composition" className="text-[15px] font-semibold">
          Shareholders composition
        </h2>
        <span className="text-[13px] text-muted-foreground">
          {monthLabel(month.dataDate)}
        </span>
      </div>
      <MonthTabs page={page} selected={month.dataDate} onMonth={onMonth} />
      <div
        role="group"
        aria-label="Origin"
        className="flex flex-wrap items-center gap-2"
      >
        {ORIGINS.map(({ value, label }) => (
          <Choice
            key={value}
            pressed={shown === value}
            unavailable={
              value !== "all" && !month.split
                ? `${label}: ${NOT_SPLIT}`
                : undefined
            }
            onPick={() => onOrigin(value)}
            className="h-7 rounded-full px-3 text-[13px]"
          >
            {label}
          </Choice>
        ))}
      </div>
      <Totals shown={rows} origin={shown} />
      <ul aria-label="Holders" className="flex flex-col">
        {rows.rows.map((row) => (
          <HolderRow key={row.key} row={row} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          <ComparisonNote page={page} origin={shown} />
        </p>
        <KChip
          selected={level === "classifications"}
          onSelectedChange={(on) => setLevel(on ? "classifications" : "types")}
        >
          Show all 39 classes
        </KChip>
      </div>
    </section>
  )
}

// A pressed-or-not button of a single choice. An unavailable one stays
// focusable, so its tooltip says why.
function Choice({
  pressed,
  unavailable,
  onPick,
  className,
  children,
}: {
  pressed: boolean
  unavailable: string | undefined
  onPick: () => void
  className: string
  children: ReactNode
}) {
  const button = (
    <button
      type="button"
      aria-pressed={pressed}
      aria-disabled={unavailable !== undefined}
      onClick={() => unavailable === undefined && onPick()}
      className={cn(
        "border border-border whitespace-nowrap",
        kFocus,
        unavailable === undefined
          ? "hover:bg-elevated aria-pressed:border-up aria-pressed:text-up aria-pressed:font-semibold"
          : "cursor-not-allowed opacity-40",
        className
      )}
    >
      {children}
    </button>
  )
  return unavailable === undefined ? (
    button
  ) : (
    <KTooltip content={unavailable}>{button}</KTooltip>
  )
}

function MonthTabs({
  page,
  selected,
  onMonth,
}: {
  page: StockPage
  selected: string
  onMonth: (dataDate: string) => void
}) {
  return (
    <div
      role="group"
      aria-label="Month"
      className="grid grid-cols-4 gap-1.5 sm:grid-cols-8"
    >
      {page.months.map(({ dataDate, held }) => (
        <Choice
          key={dataDate}
          pressed={dataDate === selected}
          unavailable={
            held
              ? undefined
              : `${page.code} isn't in ${monthLabel(dataDate)}'s report.`
          }
          onPick={() => onMonth(dataDate)}
          className="rounded-sm px-1 py-1.5 text-[12px]"
        >
          {monthLabel(dataDate)}
        </Choice>
      ))}
    </div>
  )
}

function SplitBar({
  left,
  right,
  share,
}: {
  left: { label: string; color: string }
  right: { label: string; color: string }
  share: number
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[12px] text-muted-foreground">
        <span>{left.label}</span>
        <span>{right.label}</span>
      </div>
      <div
        aria-hidden
        className="bg-elevated flex h-1.5 overflow-hidden rounded-xs"
      >
        <i
          className="block h-full"
          style={{ width: `${share * 100}%`, background: left.color }}
        />
        <i
          className="block h-full"
          style={{ width: `${(1 - share) * 100}%`, background: right.color }}
        />
      </div>
      <div className="num flex justify-between text-[13px] font-semibold">
        <span style={{ color: left.color }}>{percent(share)}</span>
        <span style={{ color: right.color }}>{percent(1 - share)}</span>
      </div>
    </div>
  )
}

function Totals({
  shown,
  origin,
}: {
  shown: Composition
  origin: PanelOrigin
}) {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-border p-3">
      <div className="flex justify-between gap-3 font-semibold">
        <span>
          Total scripless shares{origin === "all" ? "" : ` (${origin})`}
        </span>
        <span className="num" aria-label="Total scripless shares">
          {Effect.runSync(compact(shown.total))}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SplitBar
          left={{ label: "Retail", color: "var(--investor-id)" }}
          right={{ label: "Institution", color: "var(--semantic-info)" }}
          share={shown.retail}
        />
      </div>
    </div>
  )
}

function HolderRow({ row }: { row: Composition["rows"][number] }) {
  const was =
    row.previousShare === undefined ||
    percent(row.previousShare) === percent(row.share)
      ? undefined
      : row.previousShare
  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">
          <span
            aria-hidden
            className="mr-1.5 inline-block size-2.5 rounded-[2px]"
            style={{ background: TYPE_COLOR[row.type] }}
          />
          {row.label}{" "}
          <span className="num text-[12px] text-muted-foreground">
            {Effect.runSync(compact(row.shares))}
          </span>
        </span>
        <span className="num shrink-0 text-[13px]">
          {was !== undefined && (
            <span className="text-muted-foreground">{percent(was)} → </span>
          )}
          <b
            className={cn(
              was !== undefined && (row.share > was ? "text-up" : "text-down")
            )}
          >
            {percent(row.share)}
          </b>
        </span>
      </div>
      <div aria-hidden className="bg-elevated h-1 overflow-hidden rounded-xs">
        <i
          className="block h-full"
          style={{
            width: `${row.share * 100}%`,
            background: TYPE_COLOR[row.type],
          }}
        />
      </div>
    </li>
  )
}

// What the `last month → this month` figures compare with, or why there are
// none.
function ComparisonNote({
  page,
  origin,
}: {
  page: StockPage & { readonly composition: Composed }
  origin: PanelOrigin
}) {
  const { month, previous } = page.composition
  const index = page.months.findIndex(
    ({ dataDate }) => dataDate === month.dataDate
  )
  const before = page.months[index - 1]
  if (
    before === undefined ||
    !page.months.slice(0, index).some(({ held }) => held)
  )
    return "First month in the report."
  if (previous === undefined)
    return `${page.code} isn't in ${monthLabel(before.dataDate)}'s report, so no change is shown.`
  if (origin !== "all" && !previous.split)
    return `${monthLabel(previous.dataDate)} has no local/foreign split, so no change is shown.`
  return `Changes are from ${monthLabel(previous.dataDate)}.`
}
