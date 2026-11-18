// The Book readout's fill estimate (spec apinrdw/kumora#517, "Book
// readings"): what an order of this browser's size would fill at against the
// selected code's whole book, a buy walking the offers and a sell the bids.
import {
  fillEstimateOf,
  type FillEstimate,
  type OrderBook,
  type OrderSize,
} from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useState, useSyncExternalStore } from "react"

import { compact, lots, plain, price } from "@/lib/format"

import type { OrderBookStore } from "./order-book-store"
import { useOrderSize } from "./use-order-size"

// The field takes rupiah in millions.
const MILLION = 1e6

const UNITS = [
  { unit: "rupiah", label: "Rupiah", suffix: "Rp M" },
  { unit: "lots", label: "Lots", suffix: "lots" },
] as const

const SIDES = [
  { side: "buy", heading: "Buy · walks offers", walked: "offers" },
  { side: "sell", heading: "Sell · walks bids", walked: "bids" },
] as const

const shownAmount = (size: OrderSize) =>
  Effect.succeed(
    String(size.unit === "rupiah" ? size.amount / MILLION : size.amount)
  )

// The amount `text` asks for in `unit`, or none when it isn't one: lots are
// whole and every amount is over zero.
const amountOf = (text: string, unit: OrderSize["unit"]) =>
  Effect.sync(() => {
    const typed = Number(text.replaceAll(",", ""))
    const amount = unit === "rupiah" ? typed * MILLION : Math.floor(typed)
    return Number.isFinite(amount) && amount > 0 ? amount : undefined
  })

// The order-size field and its Rupiah / Lots toggle. While typing, the field
// keeps the text; each valid amount is saved as it is typed.
function SizeField() {
  const { size, pickUnit, changeAmount } = useOrderSize()
  const [draft, setDraft] = useState<string>()
  const suffix = UNITS.find((each) => each.unit === size.unit)?.suffix
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground">Order size</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label="Order size"
        value={draft ?? Effect.runSync(shownAmount(size))}
        onChange={(event) => {
          setDraft(event.target.value)
          const amount = Effect.runSync(amountOf(event.target.value, size.unit))
          if (amount !== undefined) changeAmount(amount)
        }}
        onBlur={() => setDraft(undefined)}
        className="w-28 rounded-md border border-border bg-background px-1.5 py-0.5 tabular-nums"
      />
      <span className="text-muted-foreground">{suffix}</span>
      <span
        role="group"
        aria-label="Order size unit"
        className="ml-auto flex gap-1 text-[11px]"
      >
        {UNITS.map(({ unit, label }) => (
          <button
            key={unit}
            type="button"
            aria-pressed={size.unit === unit}
            onClick={() => {
              setDraft(undefined)
              pickUnit(unit)
            }}
            className={cn(
              "rounded-md border border-border px-1.5 py-px",
              size.unit === unit
                ? "border-primary text-primary"
                : "hover:bg-elevated"
            )}
          >
            {label}
          </button>
        ))}
      </span>
    </div>
  )
}

const ticksText = (ticks: number) =>
  Effect.succeed(`${ticks} ${ticks === 1 ? "tick" : "ticks"}`)

// One side's column: levels used (with a + when the book runs out), last
// price, average fill and slippage, or dashes when nothing fills.
const columnOf = Effect.fnUntraced(function* (fill: FillEstimate | undefined) {
  if (fill === undefined) return ["—", "—", "—", "—"]
  return [
    `${fill.levels}${fill.short ? "+" : ""}`,
    yield* price(fill.last),
    yield* plain(fill.average, fill.average < 200 ? 1 : 0),
    `${yield* ticksText(fill.slippage.ticks)} · ${yield* plain(fill.slippage.percent, 2)}%`,
  ]
})

const ROWS = ["Levels used", "Last price", "Average fill", "Slippage"]

const shortNote = Effect.fnUntraced(function* (
  fill: FillEstimate,
  walked: string
) {
  return `More than the ${fill.levels} levels shown: the ${walked} cover ${yield* lots(fill.lots)} lots (Rp${yield* compact(fill.rupiah)}).`
})

/**
 * The fill estimate over the selected code's book, live or at a recorded
 * day's cursor, greyed with the readings while they are paused. In a
 * recorded relay gap (`unrecorded`) it fills nothing: the book held there
 * is the last one before the gap.
 */
export function FillEstimatePart({
  store,
  paused,
  unrecorded,
}: {
  store: OrderBookStore
  paused: boolean
  unrecorded: boolean
}) {
  const held = useSyncExternalStore(
    store.subscribe,
    store.book,
    () => undefined
  )
  const { size } = useOrderSize()
  const book: OrderBook | undefined =
    !unrecorded && held?._tag === "OrderBook" ? held : undefined
  const fills = SIDES.map(({ side, walked }) => ({
    walked,
    fill:
      book === undefined
        ? undefined
        : Effect.runSync(fillEstimateOf(book, side, size)),
  }))
  const columns = fills.map(({ fill }) => Effect.runSync(columnOf(fill)))
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 text-[12px]",
        paused && "opacity-50"
      )}
    >
      <SizeField />
      <div
        role="table"
        aria-label="Fill estimate"
        className="grid grid-cols-[auto_1fr_1fr] gap-x-2.5 gap-y-0.5 tabular-nums"
      >
        <span />
        {SIDES.map(({ side, heading }) => (
          <span
            key={side}
            className="text-right text-[10px] tracking-[0.08em] text-muted-foreground uppercase"
          >
            {heading}
          </span>
        ))}
        {ROWS.map((row, index) => [
          <span key={row} className="text-muted-foreground">
            {row}
          </span>,
          ...columns.map((column, side) => (
            <span key={`${row}-${side}`} className="text-right">
              {column[index]}
            </span>
          )),
        ])}
      </div>
      {unrecorded && (
        <p className="text-[11px] text-muted-foreground">Not recorded</p>
      )}
      {fills.map(({ fill, walked }) =>
        fill?.short ? (
          <p key={walked} className="text-warning text-[11px]">
            {Effect.runSync(shortNote(fill, walked))}
          </p>
        ) : null
      )}
    </div>
  )
}
