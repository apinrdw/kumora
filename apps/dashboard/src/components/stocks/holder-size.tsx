// The stock page's Holder size panel (spec apinrdw/kumora#402, "Holder size
// panel"; apinrdw/kumora#398's layout B): month tabs, an origin and a
// denominator switch, then the Bars view of one investor-type report month,
// a bar of scrip, ≥5% holders and <5% holders and a table of the 9 KSEI
// investor types, each against the month before.
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { kCard } from "@/components/k/styles"
import { Choice, MonthTabs } from "@/components/stocks/choice"
import { compact, plain } from "@/lib/format"
import {
  type Denominator,
  type HolderSize as Figures,
  type Holding,
  holderSize,
} from "@/lib/holder-size"
import { monthLabel, percent } from "@/lib/stock-page-display"
import type { OriginShown } from "@/lib/stock-search"
import type { HolderSizeMonth } from "@/server/holdings/stock-page"

const ORIGINS: ReadonlyArray<{ value: OriginShown; label: string }> = [
  { value: "all", label: "All" },
  { value: "local", label: "Local" },
  { value: "foreign", label: "Foreign" },
]

const DENOMINATORS: ReadonlyArray<{ value: Denominator; label: string }> = [
  { value: "outstanding", label: "Shares outstanding" },
  { value: "scripless", label: "Scripless" },
]

const PART = {
  scrip: { label: "Scrip", color: "var(--semantic-warning)" },
  atLeast5: { label: "≥5% holders", color: "var(--semantic-info)" },
  under5: {
    label: "<5% holders",
    color: "color-mix(in oklab, var(--semantic-info) 40%, transparent)",
  },
} as const

const CHOICE = "h-7 rounded-full px-3 text-[13px]"

type HeldMonth = HolderSizeMonth & { readonly holding: Holding }

export type HolderSizeProps = {
  code: string
  months: ReadonlyArray<HolderSizeMonth>
  // The URL's `YYYY-MM`; a month the stock has no row in shows its newest.
  month: string | undefined
  origin: OriginShown
  denominator: Denominator
  onMonth: (dataDate: string) => void
  onOrigin: (origin: OriginShown) => void
  onDenominator: (denominator: Denominator) => void
}

export function HolderSize({
  code,
  months,
  month,
  origin,
  denominator,
  onMonth,
  onOrigin,
  onDenominator,
}: HolderSizeProps) {
  const held = months.filter(
    (each): each is HeldMonth => each.holding !== undefined
  )
  const selected =
    held.find(({ dataDate }) => dataDate.slice(0, 7) === month) ?? held.at(-1)
  return (
    <section
      aria-labelledby="holder-size"
      className={cn(kCard, "flex flex-col gap-3")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="holder-size" className="text-[15px] font-semibold">
          Holder size
        </h2>
        {selected && (
          <span className="text-[13px] text-muted-foreground">
            {Effect.runSync(monthLabel(selected.dataDate))}
          </span>
        )}
      </div>
      {selected === undefined ? (
        <p className="text-muted-foreground">
          {code} isn't in IDX's investor-type report, so its holder size isn't
          shown.
        </p>
      ) : (
        <Month
          code={code}
          months={months}
          selected={selected}
          origin={origin}
          denominator={denominator}
          onMonth={onMonth}
          onOrigin={onOrigin}
          onDenominator={onDenominator}
        />
      )}
    </section>
  )
}

function Month({
  code,
  months,
  selected,
  origin,
  denominator,
  onMonth,
  onOrigin,
  onDenominator,
}: Omit<HolderSizeProps, "month"> & { selected: HeldMonth }) {
  const index = months.indexOf(selected)
  const before = months[index - 1]
  const figures = Effect.runSync(
    holderSize(selected.holding, before?.holding, origin, denominator)
  )
  return (
    <>
      <MonthTabs
        code={code}
        months={months.map((each) => ({
          dataDate: each.dataDate,
          held: each.holding !== undefined,
        }))}
        selected={selected.dataDate}
        onMonth={onMonth}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div
          role="group"
          aria-label="Origin"
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-[12px] text-muted-foreground">IDX's split</span>
          {ORIGINS.map(({ value, label }) => (
            <Choice
              key={value}
              pressed={figures.origin === value}
              unavailable={
                value !== "all" && !selected.split
                  ? `${label}: Not reported before Jan 2026`
                  : undefined
              }
              onPick={() => onOrigin(value)}
              className={CHOICE}
            >
              {label}
            </Choice>
          ))}
        </div>
        <div
          role="group"
          aria-label="Share of"
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-[12px] text-muted-foreground">Share of</span>
          {DENOMINATORS.map(({ value, label }) => (
            <Choice
              key={value}
              pressed={figures.denominator === value}
              unavailable={
                value === "outstanding" && figures.origin !== "all"
                  ? "Scrip isn't split by origin"
                  : undefined
              }
              onPick={() => onDenominator(value)}
              className={CHOICE}
            >
              {label}
            </Choice>
          ))}
        </div>
      </div>
      <Bars figures={figures} />
      <p className="text-[12px] text-muted-foreground">
        {Effect.runSync(comparison(code, months, index, figures.origin))}
      </p>
      <p className="text-[12px] text-muted-foreground">
        IDX counts a holder as ≥5% when one investor holds at least 5% of shares
        outstanding in scripless form. A big holder spread across types can show
        part of its stake as &lt;5%, so the split by type is approximate.
      </p>
    </>
  )
}

// The Bars view: the whole stock's bar, then each type's bands.
function Bars({ figures }: { figures: Figures }) {
  const parts = (
    [
      ["scrip", figures.bar.scrip],
      ["atLeast5", figures.bar.atLeast5],
      ["under5", figures.bar.under5],
    ] as const
  ).flatMap(([key, share]) =>
    share === undefined
      ? []
      : [{ key, share, change: figures.changes?.[key], ...PART[key] }]
  )
  return (
    <>
      <div
        role="group"
        aria-label="Holder size bar"
        className="flex flex-col gap-2"
      >
        <div
          aria-hidden
          className="bg-elevated flex h-7 overflow-hidden rounded-sm"
        >
          {parts.map(({ key, share, color }) => (
            <i
              key={key}
              className="block h-full"
              style={{ width: `${share * 100}%`, background: color }}
            />
          ))}
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
          {parts.map(({ key, label, share, change, color }) => (
            <div key={key} className="flex items-baseline gap-1.5">
              <dt>
                <span
                  aria-hidden
                  className="mr-1.5 inline-block size-2.5 rounded-[2px]"
                  style={{ background: color }}
                />
                {label}
              </dt>
              <dd className="num font-semibold">
                {Effect.runSync(percent(share))} <Change change={change} />
              </dd>
            </div>
          ))}
          <div className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">Shares</dt>
            <dd className="num">{Effect.runSync(compact(figures.base))}</dd>
          </div>
        </dl>
      </div>
      <div className="overflow-x-auto">
        <table
          aria-label="Holder size by investor type"
          className="w-full text-[13px] [&_td]:py-1.5 [&_td]:text-right [&_td:first-child]:text-left [&_th]:py-1.5 [&_th]:text-right [&_th]:font-medium [&_th]:text-muted-foreground [&_th:first-child]:text-left [&_tr]:border-b [&_tr]:border-border"
        >
          <thead>
            <tr>
              <th scope="col">Investor type</th>
              <th scope="col">≥5%</th>
              <th scope="col">Change</th>
              <th scope="col">&lt;5%</th>
              <th scope="col">Change</th>
              <th scope="col">Of the type in ≥5%</th>
            </tr>
          </thead>
          <tbody className="num whitespace-nowrap">
            {figures.rows.map((row) => (
              <tr
                key={row.type}
                className={cn(
                  row.inAtLeast5 === undefined && "text-muted-foreground"
                )}
              >
                <th scope="row" className="font-sans">
                  {row.label}
                </th>
                <td>{Effect.runSync(percent(row.atLeast5))}</td>
                <td>
                  <Change change={row.atLeast5Change} />
                </td>
                <td>{Effect.runSync(percent(row.under5))}</td>
                <td>
                  <Change change={row.under5Change} />
                </td>
                <td>
                  {row.inAtLeast5 === undefined
                    ? "–"
                    : Effect.runSync(percent(row.inAtLeast5))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// A change in percentage points with its arrow; none without a month before.
function Change({ change }: { change: number | undefined }) {
  if (change === undefined) return null
  const text = Effect.runSync(plain(Math.abs(change) * 100, 2))
  const flat = text === "0.00"
  return (
    <span
      className={cn(
        "font-normal",
        flat ? "text-muted-foreground" : change > 0 ? "text-up" : "text-down"
      )}
    >
      {flat ? "" : change > 0 ? "▲ " : "▼ "}
      {text} pts
    </span>
  )
}

// What the changes compare with, or why there are none.
const comparison = (
  code: string,
  months: ReadonlyArray<HolderSizeMonth>,
  index: number,
  origin: OriginShown
) =>
  Effect.gen(function* () {
    const before = months[index - 1]
    if (
      before === undefined ||
      months.slice(0, index).every(({ holding }) => holding === undefined)
    )
      return "First month in the report."
    const label = yield* monthLabel(before.dataDate)
    if (before.holding === undefined)
      return `${code} isn't in ${label}'s report, so no change is shown.`
    if (origin !== "all" && !before.split)
      return `${label} has no local/foreign split, so no change is shown.`
    return `Changes are from ${label}.`
  })
