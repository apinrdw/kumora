// The stock page's Holder size panel (spec apinrdw/kumora#402, "Holder size
// panel"; apinrdw/kumora#398's layout B with C's chart): an origin and a
// denominator switch, then one of two views. Bars shows one investor-type
// report month, picked by month tabs: a bar of scrip, ≥5% holders and <5%
// holders and a table of the 9 KSEI investor types, each against the month
// before. Table shows every month as a stacked column, then the types
// holding ≥5% month by month.
import type { StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { kCard, kFocus } from "@/components/k/styles"
import { KTooltip } from "@/components/k/tooltip"
import { Choice, MonthTabs, Picks } from "@/components/stocks/choice"
import type { KseiType } from "@/domain/holdings"
import { compact, plain } from "@/lib/format"
import {
  type HolderSize as Figures,
  type HolderSizeColumn,
  type HolderSizeFigures,
  type HolderSizeTable,
  type Holding,
  holderSize,
  holderSizeTable,
} from "@/lib/holder-size"
import { monthLabel, percent, shortMonth } from "@/lib/stock-page-display"
import type { ChartView, OriginShown, SizeBase } from "@/lib/stock-search"
import type { HolderSizeMonth } from "@/server/holdings/stock-page"

const ORIGINS: ReadonlyArray<{ value: OriginShown; label: string }> = [
  { value: "all", label: "All" },
  { value: "local", label: "Local" },
  { value: "foreign", label: "Foreign" },
]

const DENOMINATORS: ReadonlyArray<{ value: SizeBase; label: string }> = [
  { value: "outstanding", label: "Shares outstanding" },
  { value: "scripless", label: "Scripless" },
]

const VIEWS: ReadonlyArray<{ value: ChartView; label: string }> = [
  { value: "bars", label: "Bars" },
  { value: "table", label: "Table" },
]

const PART = {
  scrip: { label: "Scrip", color: "var(--semantic-neutral)" },
  atLeast5: { label: "≥5% holders", color: "var(--semantic-info)" },
  under5: {
    label: "<5% holders",
    color: "color-mix(in oklab, var(--semantic-info) 40%, transparent)",
  },
} as const

// A column's parts, bottom up.
const STACK = ["atLeast5", "under5", "scrip"] as const

const CHOICE = "h-7 rounded-full px-3 text-[13px]"

// The Table view's column height in px.
const HEIGHT = 200

type HeldMonth = HolderSizeMonth & { readonly holding: Holding }

export type HolderSizeProps = {
  code: StockCode
  months: ReadonlyArray<HolderSizeMonth>
  // The URL's `YYYY-MM`; a month the stock has no row in shows its newest.
  month: string | undefined
  origin: OriginShown
  denominator: SizeBase
  view: ChartView
  onMonth: (dataDate: string) => void
  onOrigin: (origin: OriginShown) => void
  onDenominator: (denominator: SizeBase) => void
  onView: (view: ChartView) => void
}

export function HolderSize({
  code,
  months,
  month,
  view,
  onView,
  ...shown
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="holder-size" className="text-[15px] font-semibold">
          Holder size
        </h2>
        {selected && (
          <div className="flex flex-wrap items-center gap-3">
            {view === "bars" && (
              <span className="text-[13px] text-muted-foreground">
                {Effect.runSync(monthLabel(selected.dataDate))}
              </span>
            )}
            <Picks label="View" options={VIEWS} value={view} onPick={onView} />
          </div>
        )}
      </div>
      {selected === undefined ? (
        <p className="text-muted-foreground">
          {code} isn't in IDX's investor-type report, so its holder size isn't
          shown.
        </p>
      ) : view === "bars" ? (
        <Month code={code} months={months} selected={selected} {...shown} />
      ) : (
        <Months code={code} months={months} {...shown} />
      )}
      {selected && (
        <p className="text-[12px] text-muted-foreground">
          IDX counts a holder as ≥5% when one investor holds at least 5% of
          shares outstanding in scripless form. A big holder spread across types
          can show part of its stake as &lt;5%, so the split by type is
          approximate.
        </p>
      )}
    </section>
  )
}

type Shown = Pick<
  HolderSizeProps,
  "origin" | "denominator" | "onMonth" | "onOrigin" | "onDenominator"
>

// The Bars view of the selected month.
function Month({
  code,
  months,
  selected,
  origin,
  denominator,
  onMonth,
  onOrigin,
  onDenominator,
}: Shown & {
  code: StockCode
  months: ReadonlyArray<HolderSizeMonth>
  selected: HeldMonth
}) {
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
      <Controls
        figures={figures}
        split={selected.split}
        onOrigin={onOrigin}
        onDenominator={onDenominator}
      />
      <Bars figures={figures} />
      <p className="text-[12px] text-muted-foreground">
        {Effect.runSync(comparison(code, months, index, figures.origin))}
      </p>
    </>
  )
}

// The Table view of every month.
function Months({
  code,
  months,
  origin,
  denominator,
  onOrigin,
  onDenominator,
}: Shown & { code: StockCode; months: ReadonlyArray<HolderSizeMonth> }) {
  const table = Effect.runSync(holderSizeTable(months, origin, denominator))
  return (
    <>
      <Controls
        figures={table}
        split={months.some(({ split }) => split)}
        onOrigin={onOrigin}
        onDenominator={onDenominator}
      />
      <Columns table={table} />
      <AtLeast5Table code={code} table={table} />
    </>
  )
}

// The origin and denominator switches. Local and Foreign are unavailable
// without a split; shares outstanding is for all only.
function Controls({
  figures,
  split,
  onOrigin,
  onDenominator,
}: {
  figures: Pick<Figures, "origin" | "denominator">
  split: boolean
  onOrigin: (origin: OriginShown) => void
  onDenominator: (denominator: SizeBase) => void
}) {
  return (
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
              value !== "all" && !split
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
  )
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="mr-1.5 inline-block size-2.5 rounded-[2px]"
      style={{ background: color }}
    />
  )
}

// The Bars view: the whole stock's bar, then each type's ≥5% and <5% holders.
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
                <Swatch color={color} />
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
  code: StockCode,
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

// A column's parts, bottom up, as drawn.
const stacked = (column: HolderSizeFigures) =>
  Effect.succeed(
    STACK.flatMap((key) => {
      const share = column.bar[key]
      return share === undefined ? [] : [{ key, share, ...PART[key] }]
    })
  )

// What a column says: its parts, or why it has none.
const columnText = Effect.fnUntraced(function* (column: HolderSizeColumn) {
  const label = yield* monthLabel(column.dataDate)
  if (column.shown !== "figures")
    return column.shown === "no data"
      ? `${label}: No data`
      : `${label}: n/a, not split by origin`
  const parts = yield* Effect.forEach(
    yield* stacked(column),
    ({ label: part, share }) =>
      Effect.map(percent(share), (text) => `${part} ${text}`)
  )
  return `${label}: ${parts.join(", ")}`
})

// The Table view's chart: a column per month, ≥5% holders at the bottom.
function Columns({ table }: { table: HolderSizeTable }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto pb-1">
        <ol
          aria-label="Holder size by month"
          className="flex w-max min-w-full gap-2 px-1"
        >
          {table.columns.map((column) => (
            <li key={column.dataDate} className="flex flex-col items-center">
              <Column column={column} />
              <span className="num h-5 text-[11px] leading-5 whitespace-nowrap text-muted-foreground">
                {Effect.runSync(shortMonth(column.dataDate))}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted-foreground">
        {STACK.filter(
          (key) => key !== "scrip" || table.denominator === "outstanding"
        ).map((key) => (
          <li key={key}>
            <Swatch color={PART[key].color} />
            {PART[key].label}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Column({ column }: { column: HolderSizeColumn }) {
  const text = Effect.runSync(columnText(column))
  return (
    <KTooltip side="right" content={text}>
      <button
        type="button"
        aria-label={text}
        className={cn(
          "bg-elevated flex w-9 flex-col-reverse overflow-hidden rounded-xs",
          kFocus
        )}
        style={{ height: HEIGHT }}
      >
        {column.shown === "figures" ? (
          Effect.runSync(stacked(column)).map(({ key, share, color }) => (
            <i
              key={key}
              className="block w-full shrink-0"
              style={{ height: share * HEIGHT, background: color }}
            />
          ))
        ) : (
          <span className="m-auto rotate-180 text-[10px] whitespace-nowrap text-muted-foreground [writing-mode:vertical-rl]">
            {column.shown === "unsplit" ? "n/a" : "No data"}
          </span>
        )}
      </button>
    </KTooltip>
  )
}

// A cell of the ≥5% table: the type's share, n/a for an unsplit month, a
// dash for a month without the stock.
const atLeast5Cell = (column: HolderSizeColumn, type: KseiType) =>
  column.shown === "figures"
    ? percent(column.atLeast5[type])
    : Effect.succeed(column.shown === "unsplit" ? "n/a" : "–")

function AtLeast5Table({
  code,
  table,
}: {
  code: StockCode
  table: HolderSizeTable
}) {
  if (table.atLeast5Types.length === 0)
    return (
      <p className="text-[13px] text-muted-foreground">
        {code} has no {table.origin === "all" ? "" : `${table.origin} `}≥5%
        holders in any month.
      </p>
    )
  return (
    <div className="overflow-x-auto">
      <table
        aria-label="≥5% holders by month"
        className="w-full text-[13px] whitespace-nowrap [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-right [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-right [&_th]:font-medium [&_th]:text-muted-foreground [&_th:first-child]:text-left [&_tr]:border-b [&_tr]:border-border"
      >
        <thead>
          <tr>
            <th scope="col">≥5% held by</th>
            {table.columns.map(({ dataDate }) => (
              <th key={dataDate} scope="col" className="num">
                {Effect.runSync(shortMonth(dataDate))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="num">
          {table.atLeast5Types.map(({ type, label }) => (
            <tr key={type}>
              <th scope="row" className="font-sans">
                {label}
              </th>
              {table.columns.map((column) => (
                <td
                  key={column.dataDate}
                  className={cn(
                    column.shown !== "figures" && "text-muted-foreground"
                  )}
                >
                  {Effect.runSync(atLeast5Cell(column, type))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
