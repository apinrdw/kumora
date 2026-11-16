// The stock page's Broker inventory tab (spec apinrdw/kumora#437, "Dashboard:
// the stock page"; prototype variant B, as amended on apinrdw/kumora#421):
// the range controls and the chart of the Top 5 net buy and Top 5 net sell
// brokers' broker inventory, all from one read.
import { WibDate, type StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, Option, Schema } from "effect"
import { useMemo } from "react"

import { KInput } from "@/components/k/input"
import { kCard } from "@/components/k/styles"
import { Picks } from "@/components/stocks/choice"
import {
  BrokerInventoryChart,
  type InventoryLine,
} from "@/components/stocks/broker-inventory-chart"
import {
  brokerSummary,
  type InventoryWindow,
  type Lens,
  RANGE_PRESETS,
  type RangePreset,
  runningNets,
  topBrokers,
} from "@/lib/broker-inventory"
import { dayLabel } from "@/lib/format"
import type { BrokerInventoryRead } from "@/server/broker-totals/inventory"

const LENS: Lens = { measure: "lots", investor: "all" }

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

type RangeChoice = RangePreset | "custom"

const RANGES: ReadonlyArray<{ value: RangeChoice; label: string }> = [
  ...RANGE_PRESETS.map((preset) => ({ value: preset, label: preset })),
  { value: "custom", label: "Custom" },
]

const decodeDate = Schema.decodeUnknownOption(WibDate)

// The Top 5 net buy and Top 5 net sell lines.
const topLines = Effect.fnUntraced(function* (read: BrokerInventoryRead) {
  const top = yield* topBrokers(yield* brokerSummary(read, LENS))
  const nets = yield* runningNets(read, LENS, [...top.buy, ...top.sell])
  return [
    ...top.buy.map((broker, rank) => ({
      broker,
      color: BUY_COLORS[rank] ?? "currentColor",
      values: nets.get(broker) ?? [],
    })),
    ...top.sell.map((broker, rank) => ({
      broker,
      color: SELL_COLORS[rank] ?? "currentColor",
      values: nets.get(broker) ?? [],
    })),
  ] satisfies ReadonlyArray<InventoryLine>
})

export function BrokerInventory({
  code,
  read,
  window,
  onWindow,
}: {
  code: StockCode
  read: BrokerInventoryRead
  window: InventoryWindow
  onWindow: (window: InventoryWindow) => void
}) {
  const lines = useMemo(() => Effect.runSync(topLines(read)), [read])
  const choice: RangeChoice = "range" in window ? window.range : "custom"
  // A picked date that parses, From kept before To.
  const pickDate = (end: "from" | "to", value: string) => {
    const date = decodeDate(value)
    if (Option.isNone(date)) return
    const from = end === "from" ? date.value : read.from
    const to = end === "to" ? date.value : read.to
    onWindow(from <= to ? { from, to } : { from: date.value, to: date.value })
  }
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
      {read.days.length === 0 ? (
        <p className="text-muted-foreground">
          No broker inventory for {code} in this range yet.
        </p>
      ) : (
        <BrokerInventoryChart
          code={code}
          days={read.days}
          built={read.built}
          candles={read.candles}
          lines={lines}
        />
      )}
    </section>
  )
}
