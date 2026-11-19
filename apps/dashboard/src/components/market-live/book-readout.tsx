// The Book readout (spec apinrdw/kumora#517, "The Book readout"): a
// full-width card under the candle chart with the selected code's book
// readings, live from the viewer socket or, on a recorded day, read from the
// stored frame at the cursor. It has three parts side by side: the readings,
// the fill estimate and the book events, passed in as `events`
// (book-events.tsx).
import {
  INDEX_CODES,
  READING_PHASES,
  bookReadingsOf,
  limitOf,
  marketPhases,
  type BookReadings,
  type Limit,
  type MarketPhase,
  type OrderBook,
  type RelayGap,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { DateTime, Effect } from "effect"
import { useSyncExternalStore, type ReactNode } from "react"

import { DISCLAIMER, isCheap, type CodePrices } from "@/lib/book-readings"
import { compact, lots, plain, signed, tapeTime } from "@/lib/format"
import { gapAt } from "@/lib/replay"

import type { BookReadingsStore } from "./book-readings-store"
import { useDayState, type DayStateStore } from "./day-state-store"
import { FillEstimatePart } from "./fill-estimate"
import { PHASE, useMarketPhase } from "./market-conditions"
import type { OrderBookStore } from "./order-book-store"
import type { ReplayCursor } from "./replay-cursor"
import { useSpecialBoard } from "./use-special-board"

const LIMIT_NAMES = { upper: "upper", lower: "lower" } as const

// What the strip says while readings are paused in `phase`, at `clock`'s
// now (the object's): when the last session ended today, or when the next
// starts.
const pauseNote = Effect.fnUntraced(function* (
  today: WibDate,
  phase: MarketPhase,
  clock: Effect.Effect<number>
) {
  const now = yield* clock
  const sessions = (yield* marketPhases(today).pipe(
    Effect.orElseSucceed(() => [])
  )).filter((each) => READING_PHASES.has(each.phase))
  const ended = sessions
    .filter((each) => DateTime.toEpochMillis(each.to) <= now)
    .at(-1)
  if (ended !== undefined)
    return `${PHASE[phase]} · readings paused at ${yield* tapeTime(DateTime.toEpochMillis(ended.to) - 1_000)}`
  const next = sessions.find((each) => DateTime.toEpochMillis(each.from) > now)
  if (next !== undefined)
    return `${PHASE[phase]} · readings start at ${yield* tapeTime(DateTime.toEpochMillis(next.from))}`
  return `${PHASE[phase]} · readings paused`
})

// The diverging bar: bids to the right of the middle, offers to the left.
function ImbalanceBar({ imbalance }: { imbalance: number | undefined }) {
  const share = imbalance ?? 0
  return (
    <span
      role="meter"
      aria-label="Imbalance"
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      className="relative h-2.5 rounded-xs bg-background before:absolute before:inset-y-[-2px] before:left-1/2 before:w-px before:bg-border"
    >
      <i
        className={cn(
          "absolute inset-y-0 rounded-xs",
          share >= 0 ? "bg-up left-1/2" : "bg-down right-1/2"
        )}
        style={{ width: `${Math.abs(share) * 50}%` }}
      />
    </span>
  )
}

const figure = (text: string) => <span className="text-right">{text}</span>

const emptyTicks = (side: BookReadings["bid"]) =>
  Effect.succeed(
    side.widestGap > 1
      ? `${side.emptyTicks} (widest ${side.widestGap})`
      : `${side.emptyTicks}`
  )

const perOrder = (side: BookReadings["bid"]) =>
  side.lotsPerOrder === undefined
    ? Effect.succeed("—")
    : plain(side.lotsPerOrder, side.lotsPerOrder < 10 ? 1 : 0)

function NearDepth({ side }: { side: BookReadings["bid"] }) {
  if (side.lots === 0) return figure("—")
  return (
    <span
      className="text-right underline decoration-dotted"
      title={`${Effect.runSync(lots(side.lots))} lots`}
    >
      Rp{Effect.runSync(compact(side.nearDepth))}
    </span>
  )
}

const spreadText = (spread: BookReadings["spread"]) =>
  spread === undefined
    ? Effect.succeed("—")
    : Effect.map(
        plain(spread.percent, 2),
        (percent) =>
          `${spread.ticks} ${spread.ticks === 1 ? "tick" : "ticks"} · ${percent}%`
      )

// The imbalance row: the bar and the signed figure, none at a limit, where
// a limit queue isn't pressure.
function Imbalance({
  readings,
  limit,
}: {
  readings: BookReadings
  limit: Limit | undefined
}) {
  const shown = limit === undefined ? readings.imbalance : undefined
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
      <span className="text-muted-foreground">Imbalance</span>
      <ImbalanceBar imbalance={shown} />
      <b
        aria-label="Imbalance value"
        className={cn(
          "tabular-nums",
          shown === undefined
            ? "text-muted-foreground"
            : shown >= 0
              ? "text-up"
              : "text-down"
        )}
      >
        {shown === undefined
          ? "—"
          : `${Effect.runSync(signed(shown * 100, 0))}%`}
      </b>
    </div>
  )
}

function LimitNote({ limit }: { limit: Limit }) {
  return (
    <p className="text-[11px] text-muted-foreground">
      <span className="border-warning text-warning mr-1.5 rounded-full border px-1.5 text-[10px]">
        At {LIMIT_NAMES[limit]} limit
      </span>
      One side is empty at the auto-reject limit. A limit queue isn't pressure,
      so imbalance isn't ranked.
    </p>
  )
}

// One code's readings: imbalance with its bar, the limit mark at `prices`,
// and the bid/offer grid, greyed with `paused` naming the phase.
function Readings({
  readings,
  prices,
  paused,
}: {
  readings: BookReadings
  prices: CodePrices
  paused: string | undefined
}) {
  const limit = Effect.runSync(limitOf(readings, prices))
  return (
    <div
      data-paused={paused !== undefined || undefined}
      className="flex min-w-0 flex-col gap-2 text-[12px]"
    >
      <div className={cn("flex flex-col gap-2", paused && "opacity-50")}>
        <Imbalance readings={readings} limit={limit} />
        {limit !== undefined && <LimitNote limit={limit} />}
        <div
          role="table"
          aria-label="Bid and offer readings"
          className="grid grid-cols-[auto_1fr_1fr] gap-x-2.5 gap-y-0.5 tabular-nums"
        >
          <span />
          <span className="text-right text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
            Bid · best 5
          </span>
          <span className="text-right text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
            Offer · best 5
          </span>
          <span className="text-muted-foreground">Near depth</span>
          <NearDepth side={readings.bid} />
          <NearDepth side={readings.offer} />
          <span className="text-muted-foreground">Empty ticks</span>
          {figure(Effect.runSync(emptyTicks(readings.bid)))}
          {figure(Effect.runSync(emptyTicks(readings.offer)))}
          <span className="text-muted-foreground">Lots per order</span>
          {figure(Effect.runSync(perOrder(readings.bid)))}
          {figure(Effect.runSync(perOrder(readings.offer)))}
          <span className="text-muted-foreground">Spread</span>
          <span aria-label="Spread" className="col-span-2 text-right">
            {Effect.runSync(spreadText(readings.spread))}
          </span>
        </div>
      </div>
      {paused !== undefined && (
        <p className="text-[11px] text-muted-foreground">{paused}</p>
      )}
    </div>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="py-4 text-center text-[13px] text-muted-foreground">
      {children}
    </p>
  )
}

// Why a code shows no readings, or none: an index, a Special Monitoring
// Board code, or a price of Rp1–10. The board comes first: many of its codes
// are priced Rp1–10 too, and no book arrives for them at any price.
const excludedReason = Effect.fnUntraced(function* (
  code: StockCode,
  board: ReadonlySet<StockCode>,
  prices: CodePrices
) {
  if (INDEX_CODES.includes(code)) return "Indices have no order book."
  if (board.has(code))
    return "Special Monitoring Board: this code trades in a call auction all day, and no order book arrives for it."
  if (yield* isCheap(prices))
    return "One tick here moves the price 10–100%, so book readings would mislead."
  return undefined
})

// Live, what the strip says while readings are paused outside Sessions 1
// and 2; none in them, or on a recorded day.
function usePause(today: WibDate, live: boolean, store: BookReadingsStore) {
  const phase = useMarketPhase()
  return !live || phase === undefined || READING_PHASES.has(phase)
    ? undefined
    : Effect.runSync(pauseNote(today, phase, store.now))
}

// The live readings: the trading-day object's latest for the code, greyed
// with `paused` naming the phase.
function LiveReadings({
  code,
  store,
  prices,
  paused,
}: {
  code: StockCode
  store: BookReadingsStore
  prices: CodePrices
  paused: string | undefined
}) {
  const readings = useSyncExternalStore(
    store.subscribe,
    () => store.readingsOf(code),
    () => store.readingsOf(code)
  )
  if (readings === undefined) return <Note>{paused ?? "No readings yet."}</Note>
  return <Readings readings={readings} prices={prices} paused={paused} />
}

// Whether a recorded day's cursor is in a relay gap; never live. The book
// held there is the last one before the gap.
function useInGap(
  cursor: ReplayCursor | undefined,
  gaps: ReadonlyArray<RelayGap>
) {
  return useSyncExternalStore(
    (listener) => cursor?.subscribe(listener) ?? (() => undefined),
    () =>
      cursor !== undefined &&
      Effect.runSync(gapAt(gaps, cursor.state().at)) !== undefined,
    () => false
  )
}

// A recorded day's readings at the cursor, read from its stored frame.
function RecordedReadings({
  book,
  prices,
  inGap,
}: {
  book: OrderBook | undefined
  prices: CodePrices
  inGap: boolean
}) {
  if (inGap) return <Note>Not recorded</Note>
  if (book === undefined) return <Note>No book recorded by then.</Note>
  const readings = Effect.runSync(bookReadingsOf(book))
  return <Readings readings={readings} prices={prices} paused={undefined} />
}

// The strip's columns on a wide screen, by how many parts sit beside the
// readings.
const PART_COLUMNS = [
  undefined,
  "lg:grid-cols-[1.1fr_1fr]",
  // Decision: the book events sit under the readings and the fill estimate
  // until 2xl: in layout B's chart column at lg, three parts squeeze the fill
  // estimate's controls under the events list.
  "lg:grid-cols-[1.1fr_1fr] 2xl:grid-cols-[1.1fr_1fr_1.2fr]",
]

// The header's note: the levels read and, on a recorded day, the frame's time.
const levelsNote = (
  cursor: ReplayCursor | undefined,
  book: OrderBook | undefined
) =>
  cursor === undefined
    ? Effect.succeed("best 5 levels")
    : book === undefined
      ? Effect.succeed("best 5 levels · recorded")
      : Effect.map(
          tapeTime(DateTime.toEpochMillis(book.at)),
          (time) => `best 5 levels · recorded frame ${time}`
        )

/**
 * The selected code's Book readout: live, or at `cursor` on a recorded day.
 * An index, a Special Monitoring Board code or a code priced Rp1–10 shows
 * why it has no readings instead.
 */
export function BookReadout({
  code,
  today,
  readings,
  book,
  dayStates,
  cursor,
  gaps,
  events,
}: {
  code: StockCode
  // The live page's day.
  today: WibDate
  readings: BookReadingsStore
  book: OrderBookStore
  dayStates: DayStateStore
  cursor: ReplayCursor | undefined
  gaps: ReadonlyArray<RelayGap>
  // The book events' part (book-events.tsx).
  events?: ReactNode
}) {
  const state = useDayState(dayStates, code)
  const held = useSyncExternalStore(book.subscribe, book.book, () => undefined)
  const shown = held?._tag === "OrderBook" ? held : undefined
  // A recorded day reads today's board list too: the table keeps no
  // history, so a code that has joined or left the board since shows as it
  // stands today.
  const board = useSpecialBoard()
  const prices: CodePrices = {
    last: state?.last,
    previousClose: state?.previousClose ?? shown?.previousClose,
  }
  const reason = Effect.runSync(excludedReason(code, board, prices))
  const paused = usePause(today, cursor === undefined, readings)
  const inGap = useInGap(cursor, gaps)
  // The fill estimate, and the events when given.
  const parts = events === undefined ? 1 : 2
  return (
    <section
      aria-label="Book readout"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-2.5"
    >
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Book readout</h2>
        <span className="text-sm font-bold">{code}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {Effect.runSync(levelsNote(cursor, shown))}
        </span>
      </header>
      {reason !== undefined ? (
        <Note>{reason}</Note>
      ) : (
        <div className={cn("grid gap-3.5", PART_COLUMNS[parts])}>
          {cursor === undefined ? (
            <LiveReadings
              code={code}
              store={readings}
              prices={prices}
              paused={paused}
            />
          ) : (
            <RecordedReadings book={shown} prices={prices} inGap={inGap} />
          )}
          <FillEstimatePart
            store={book}
            paused={paused !== undefined}
            unrecorded={inGap}
          />
          {events}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{DISCLAIMER}</p>
    </section>
  )
}
