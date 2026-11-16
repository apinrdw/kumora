// The stock page's Broker inventory tab (spec apinrdw/kumora#437, "Dashboard:
// the stock page"; prototype variant B, as amended on apinrdw/kumora#421):
// the range, measure and investor controls, the plotted-brokers chips, the
// chart with its Net buy / Net sell legend beside the hover-day and
// selection panels, and the Broker summary, all from one read.
import { IconPlus, IconX } from "@tabler/icons-react"
import { type BrokerCode, type StockCode, WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, Option, Schema } from "effect"
import { useEffect, useMemo, useState } from "react"

import { KInput } from "@/components/k/input"
import { kCard, kFocus } from "@/components/k/styles"
import {
  BrokerInventoryChart,
  type DaySpan,
  type InventoryLine,
} from "@/components/stocks/broker-inventory-chart"
import {
  HoverDayPanel,
  SelectionPanel,
} from "@/components/stocks/broker-inventory-panels"
import { BrokerSummary } from "@/components/stocks/broker-summary"
import { Picks } from "@/components/stocks/choice"
import {
  brokersToDate,
  brokerSummary,
  type Chip,
  type Investor,
  type InventoryWindow,
  type Lens,
  hoverDay,
  type Measure,
  plottedBrokers,
  RANGE_PRESETS,
  type RangePreset,
  selectionSummary,
  summaryFooter,
  topBrokers,
} from "@/lib/broker-inventory"
import { dayLabel } from "@/lib/format"
import type { BrokerInventoryRead } from "@/server/broker-totals/inventory"

// Each group's line colours, by rank.
const BUY_COLORS = [
  "var(--semantic-up)",
  "var(--investor-sc)",
  "var(--investor-mf)",
  "var(--investor-fd)",
  "var(--investor-is)",
]
const SELL_COLORS = [
  "var(--semantic-down)",
  "var(--investor-cp)",
  "var(--investor-ib)",
  "var(--investor-pf)",
  "var(--investor-ot)",
]
// Single brokers' line colours, by their order among the single chips.
const SINGLE_COLORS = [
  "var(--semantic-info)",
  "var(--chart-vwap)",
  "var(--semantic-warning)",
  "var(--chart-imbalance-buy)",
  "var(--chart-imbalance-sell)",
  "var(--investor-id)",
  "var(--chart-vwap-band-2)",
  "var(--text-primary)",
]

const GROUPS = [
  { chip: "buy", label: "Top 5 net buy" },
  { chip: "sell", label: "Top 5 net sell" },
] as const

type RangeChoice = RangePreset | "custom"

// An axis day of the read it was picked on.
interface DayOf {
  readonly read: BrokerInventoryRead
  readonly day: number
}

const RANGES: ReadonlyArray<{ value: RangeChoice; label: string }> = [
  ...RANGE_PRESETS.map((preset) => ({ value: preset, label: preset })),
  { value: "custom", label: "Custom" },
]

const MEASURES: ReadonlyArray<{ value: Measure; label: string }> = [
  { value: "lots", label: "Net lots" },
  { value: "value", label: "Net value" },
]

const INVESTORS: ReadonlyArray<{ value: Investor; label: string }> = [
  { value: "all", label: "All" },
  { value: "foreign", label: "Foreign" },
  { value: "domestic", label: "Domestic" },
]

const decodeDate = Schema.decodeUnknownOption(WibDate)

// Everything the tab shows under `lens` with `chips` plotted: the summary
// and its footer, the plotted brokers' sums to date, and the lines, each a
// colour and a side of the legend.
const inventoryView = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  lens: Lens,
  chips: ReadonlyArray<Chip>
) {
  const summary = yield* brokerSummary(read, lens)
  const plotted = yield* plottedBrokers(chips, yield* topBrokers(summary))
  const toDate = yield* brokersToDate(
    read,
    lens,
    plotted.map(({ broker }) => broker)
  )
  const singles = chips.filter(
    (chip): chip is BrokerCode => chip !== "buy" && chip !== "sell"
  )
  const netOf = new Map(summary.map(({ broker, net }) => [broker, net]))
  const lines = plotted.map(({ broker, chip, rank }) => ({
    broker,
    color:
      (chip === "buy"
        ? BUY_COLORS[rank]
        : chip === "sell"
          ? SELL_COLORS[rank]
          : SINGLE_COLORS[singles.indexOf(chip) % SINGLE_COLORS.length]) ??
      "currentColor",
    values: toDate.get(broker)?.net ?? [],
    // The legend's side: a broker that didn't trade is under Net buy.
    buyer: (netOf.get(broker) ?? 0) >= 0,
  })) satisfies ReadonlyArray<InventoryLine & { buyer: boolean }>
  return {
    summary,
    footer: yield* summaryFooter(read, summary),
    toDate,
    lines,
    colors: new Map(lines.map(({ broker, color }) => [broker, color])),
    singles: new Set(singles),
  }
})

export function BrokerInventory({
  code,
  read,
  window,
  lens,
  chips,
  selection,
  onWindow,
  onLens,
  onChips,
  onSelection,
}: {
  code: StockCode
  read: BrokerInventoryRead
  window: InventoryWindow
  lens: Lens
  chips: ReadonlyArray<Chip>
  // The drag selection's axis days, from the URL.
  selection: DaySpan | undefined
  onWindow: (window: InventoryWindow) => void
  onLens: (lens: Lens) => void
  onChips: (chips: ReadonlyArray<Chip>) => void
  onSelection: (span: DaySpan | undefined) => void
}) {
  const view = useMemo(
    () => Effect.runSync(inventoryView(read, lens, chips)),
    [read, lens, chips]
  )
  const choice: RangeChoice = "range" in window ? window.range : "custom"
  // A picked date that parses, From kept before To.
  const pickDate = (end: "from" | "to", value: string) => {
    const date = decodeDate(value)
    if (Option.isNone(date)) return
    const from = end === "from" ? date.value : read.from
    const to = end === "to" ? date.value : read.to
    onWindow(from <= to ? { from, to } : { from: date.value, to: date.value })
  }
  const toggleBroker = (broker: BrokerCode) =>
    onChips(
      chips.includes(broker)
        ? chips.filter((chip) => chip !== broker)
        : [...chips, broker]
    )
  return (
    <section
      aria-labelledby="broker-inventory"
      className={cn(kCard, "flex flex-col gap-3")}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="broker-inventory" className="text-[15px] font-semibold">
          Broker inventory
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <Picks
            label="Measure"
            options={MEASURES}
            value={lens.measure}
            onPick={(measure) => onLens({ ...lens, measure })}
          />
          <Picks
            label="Investor"
            options={INVESTORS}
            value={lens.investor}
            onPick={(investor) => onLens({ ...lens, investor })}
          />
          <Picks
            label="Range"
            options={RANGES}
            value={choice}
            onPick={(next) =>
              onWindow(
                next === "custom"
                  ? { from: read.from, to: read.to }
                  : { range: next }
              )
            }
          />
          {choice === "custom" && (
            <>
              <KInput
                label="From"
                type="date"
                value={read.from}
                min={read.earliest}
                max={read.to}
                onChange={(event) => pickDate("from", event.target.value)}
                className="w-36"
              />
              <KInput
                label="To"
                type="date"
                value={read.to}
                min={read.from}
                onChange={(event) => pickDate("to", event.target.value)}
                className="w-36"
              />
            </>
          )}
        </div>
      </div>
      {read.pending !== undefined && (
        <p className="text-warning text-[12px]">
          Today ({Effect.runSync(dayLabel(read.pending))}) is pending: broker
          codes arrive after the close.
        </p>
      )}
      <Chips chips={chips} colors={view.colors} onChips={onChips} />
      {read.days.length === 0 ? (
        <p className="text-muted-foreground">
          No broker inventory for {code} in this range yet.
        </p>
      ) : (
        <>
          <ChartWithPanels
            code={code}
            read={read}
            view={view}
            measure={lens.measure}
            selection={selection}
            onSelection={onSelection}
          />
          <BrokerSummary
            rows={view.summary}
            footer={view.footer}
            measure={lens.measure}
            colors={view.colors}
            singles={view.singles}
            onToggle={toggleBroker}
          />
        </>
      )}
    </section>
  )
}

type InventoryView = Effect.Success<ReturnType<typeof inventoryView>>

// The chart and its legend, beside the hovered or pinned day's panel and
// the drag selection's.
function ChartWithPanels({
  code,
  read,
  view,
  measure,
  selection,
  onSelection,
}: {
  code: StockCode
  read: BrokerInventoryRead
  view: InventoryView
  measure: Measure
  selection: DaySpan | undefined
  onSelection: (span: DaySpan | undefined) => void
}) {
  // The hovered and the pinned day, each of the read it indexes, so a new
  // read drops them.
  const [hovered, setHovered] = useState<DayOf>()
  const [pin, setPin] = useState<DayOf>()
  const pinned = pin?.read === read ? pin.day : undefined
  const marked = pinned ?? (hovered?.read === read ? hovered.day : undefined)
  // With nothing hovered, the newest day; the read has one.
  const shown = marked ?? read.days.length - 1
  useEffect(() => {
    if (pinned === undefined) return
    const unpin = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPin(undefined)
    }
    document.addEventListener("keydown", unpin)
    return () => document.removeEventListener("keydown", unpin)
  }, [pinned])
  const hover = useMemo(
    () => Effect.runSync(hoverDay(read, view.toDate, shown)),
    [read, view, shown]
  )
  const summary = useMemo(
    () =>
      selection === undefined
        ? undefined
        : Effect.runSync(selectionSummary(read, view.toDate, selection)),
    [read, view, selection]
  )
  return (
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <BrokerInventoryChart
          code={code}
          days={read.days}
          built={read.built}
          candles={read.candles}
          lines={view.lines}
          marked={marked}
          pinned={pinned !== undefined}
          selection={selection}
          onHover={(day) =>
            setHovered(day === undefined ? undefined : { read, day })
          }
          onPin={(day) =>
            setPin(pinned === undefined ? { read, day } : undefined)
          }
          onSelect={onSelection}
        />
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
          <Legend
            label="Net buy"
            lines={view.lines.filter(({ buyer }) => buyer)}
          />
          <Legend
            label="Net sell"
            lines={view.lines.filter(({ buyer }) => !buyer)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3 xl:w-[360px] xl:shrink-0">
        <HoverDayPanel
          code={code}
          hover={hover}
          pinned={pinned !== undefined}
          measure={measure}
          colors={view.colors}
        />
        {summary !== undefined && (
          <SelectionPanel
            code={code}
            selection={summary}
            measure={measure}
            colors={view.colors}
            onClear={() => onSelection(undefined)}
          />
        )}
      </div>
    </div>
  )
}

const chipClass =
  "inline-flex h-7 items-center gap-1.5 rounded-full border border-strong bg-surface pr-1 pl-3 text-[13px] whitespace-nowrap"

// The plotted-brokers chips, each with an ✕, and an add chip for each
// group not shown.
function Chips({
  chips,
  colors,
  onChips,
}: {
  chips: ReadonlyArray<Chip>
  colors: ReadonlyMap<Chip, string>
  onChips: (chips: ReadonlyArray<Chip>) => void
}) {
  const missing = GROUPS.filter(({ chip }) => !chips.includes(chip))
  return (
    <ul aria-label="Plotted brokers" className="flex flex-wrap gap-2">
      {chips.map((chip) => {
        const group = GROUPS.find((each) => each.chip === chip)
        const label = group?.label ?? chip
        return (
          <li key={chip} className={chipClass}>
            {group === undefined && (
              <span
                aria-hidden
                style={{ background: colors.get(chip) }}
                className="size-2 rounded-full"
              />
            )}
            {label}
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={() => onChips(chips.filter((other) => other !== chip))}
              className={cn(
                "hover:bg-elevated grid size-5 place-items-center rounded-full text-muted-foreground hover:text-foreground",
                kFocus
              )}
            >
              <IconX aria-hidden stroke={1.75} className="size-3.5" />
            </button>
          </li>
        )
      })}
      {missing.map(({ chip, label }) => (
        <li key={chip}>
          <button
            type="button"
            onClick={() => onChips([...chips, chip])}
            className={cn(
              chipClass,
              "hover:bg-elevated border-dashed pr-3 pl-2 text-muted-foreground hover:text-foreground",
              kFocus
            )}
          >
            <IconPlus aria-hidden stroke={1.75} className="size-3.5" />
            {label}
          </button>
        </li>
      ))}
    </ul>
  )
}

// One side of the legend: its lines' brokers, each by its colour.
function Legend({
  label,
  lines,
}: {
  label: string
  lines: ReadonlyArray<InventoryLine>
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-muted-foreground">{label}</span>
      <ul aria-label={label} className="flex flex-wrap gap-x-3 gap-y-1">
        {lines.map(({ broker, color }) => (
          <li key={broker} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              style={{ background: color }}
              className="size-2 rounded-full"
            />
            {broker}
          </li>
        ))}
        {lines.length === 0 && <li className="text-muted-foreground">–</li>}
      </ul>
    </div>
  )
}
