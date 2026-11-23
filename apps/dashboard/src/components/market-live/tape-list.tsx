import type { RecordedTradeCodes } from "@workspace/client"
import type {
  AlertSide,
  BrokerCode,
  InvestorType,
  RelayGap,
  RunningTrade,
  StockCode,
  TradeCodes,
  ViewerDown,
} from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { DateTime, Effect } from "effect"
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { compact, lots, plain, tapeTime } from "@/lib/format"
import {
  applyViewerMessage,
  emptyTape,
  freezeTape,
  isBigTrade,
  tapeLength,
  tapeRows,
  tradeValue,
  type AuctionMatch,
  type Tape,
  type TapeRow,
} from "@/lib/tape"

import { withGapRows } from "./gap-rows"
import { INVESTOR_TEXT } from "./investor-text"

// The page's tape as an external store, drawn at most once per animation
// frame however many deltas arrive in it: each message goes into the tape at
// once, and the next frame tells React to draw them all.
const makeFramedTapeStore = Effect.sync(() => {
  let tape = Effect.runSync(emptyTape())
  let frame = 0
  let scheduled: number | undefined
  const listeners = new Set<() => void>()
  const draw = () => {
    if (scheduled !== undefined) return
    scheduled = requestAnimationFrame(() => {
      scheduled = undefined
      frame += 1
      for (const listener of listeners) listener()
    })
  }
  return {
    apply: (message: ViewerDown) => {
      tape = Effect.runSync(applyViewerMessage(tape, message))
      draw()
    },
    // A recorded day's tape at the cursor, in place of what it held.
    replace: (trades: ReadonlyArray<RunningTrade>) => {
      tape = Effect.runSync(
        applyViewerMessage(Effect.runSync(emptyTape()), {
          _tag: "Delta",
          at: DateTime.nowUnsafe(),
          tape: trades,
          candles: [],
        })
      )
      draw()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0 || scheduled === undefined) return
        cancelAnimationFrame(scheduled)
        scheduled = undefined
      }
    },
    frame: () => frame,
    tape: () => tape,
  }
})

export function useFramedTape() {
  const [store] = useState(() => Effect.runSync(makeFramedTapeStore))
  const frame = useSyncExternalStore(store.subscribe, store.frame, store.frame)
  return {
    tape: store.tape(),
    frame,
    apply: store.apply,
    replace: store.replace,
  }
}

// Every row is this tall, so the list knows which rows are in view without
// measuring them.
const ROW_PX = 22
// Rows drawn past each edge of the view, so a fast scroll shows no blank.
const OVERSCAN = 8

const SIDE_TEXT: Record<RunningTrade["side"], string> = {
  buy: "text-up",
  sell: "text-down",
  none: "",
}

const BIG_TINT: Record<RunningTrade["side"], string> = {
  buy: "bg-up/15 shadow-[inset_3px_0_0_var(--semantic-up)]",
  sell: "bg-down/15 shadow-[inset_3px_0_0_var(--semantic-down)]",
  none: "bg-neutral/15 shadow-[inset_3px_0_0_var(--semantic-neutral)]",
}

// A sweep alert's mark: its side's arrow in its side's colour.
const ALERT_MARK: Record<
  AlertSide,
  { readonly glyph: string; readonly text: string }
> = {
  buy: { glyph: "▲", text: "text-up" },
  sell: { glyph: "▼", text: "text-down" },
}

const MATCH_LABEL: Record<AuctionMatch, string> = {
  opening: "Opening match 08:58:00",
  closing: "Closing match 16:00:00",
}

type Source = RunningTrade["feeds"][number]

// One dot per feed that saw a trade, in the order the server lists them.
export const SOURCES: ReadonlyArray<{
  readonly source: Source
  readonly label: string
  readonly dot: string
}> = [
  { source: "Stockbit", label: "Stockbit", dot: "bg-info" },
  { source: "Ajaib", label: "Ajaib", dot: "bg-vwap" },
  { source: "backfill", label: "Backfill", dot: "bg-neutral" },
  { source: "walk", label: "Walk", dot: "bg-muted-foreground" },
]

function SourceDots({ feeds }: { feeds: ReadonlyArray<Source> }) {
  const shown = SOURCES.filter(({ source }) => feeds.includes(source))
  return (
    <span
      className="inline-flex gap-0.5"
      aria-label={shown.map(({ label }) => label).join(", ")}
      role="img"
    >
      {shown.map(({ source, dot }) => (
        <span key={source} className={`size-1.5 rounded-full ${dot}`} />
      ))}
    </span>
  )
}

const CELL = "h-[22px] overflow-hidden py-0 leading-[22px] whitespace-nowrap"

// Each column's width in px, in order.
// A bold 45,000 price, 123,456 lots and Rp555.55 B each fit
// whole, so no figure is clipped. The tape is never narrower than their sum:
// layout B's 400 px column (layout-b.tsx) and a phone scroll it sideways,
// because a column wide enough for the tape would narrow both charts below
// the footprint chart's 76 px a minute at 1280 px (spec apinrdw/kumora#263).
const COLUMN_PX = {
  time: 76,
  code: 84,
  price: 52,
  lot: 56,
  value: 76,
  buyer: 56,
  seller: 56,
  sources: 36,
}

const TAPE_WIDTH_PX = Object.values(COLUMN_PX).reduce((sum, px) => sum + px)

// A gap or fold row spans every column.
const COLUMNS = Object.keys(COLUMN_PX).length

// One side of a trade: its broker and the investor behind it.
interface TradeSide {
  readonly code: BrokerCode
  readonly investorType: InvestorType
}

// One side as `AK [F]`, coloured by its investor type; blank while the trade
// has no stored codes.
function BrokerCell({ side }: { side: TradeSide | undefined }) {
  return (
    <td className={cn(CELL, "pl-2", side && INVESTOR_TEXT[side.investorType])}>
      {side && `${side.code} [${side.investorType}]`}
    </td>
  )
}

// The trade's Buyer and Seller cells.
function BrokerCells({ codes }: { codes: TradeCodes | undefined }) {
  return (
    <>
      <BrokerCell
        side={codes && { code: codes.buyer, investorType: codes.buyerType }}
      />
      <BrokerCell
        side={codes && { code: codes.seller, investorType: codes.sellerType }}
      />
    </>
  )
}

// The trade's Time cell, led by its sweep alert's mark in the cell's left
// padding, so the time keeps its place.
function TimeCell({
  trade,
  inFold,
  alertSide,
}: {
  trade: RunningTrade
  inFold: boolean
  alertSide: AlertSide | undefined
}) {
  const mark = alertSide && ALERT_MARK[alertSide]
  return (
    <td className={cn(CELL, "relative pl-2", inFold && "pl-4")}>
      {mark && (
        <>
          <span
            data-sweep-alert={alertSide}
            aria-hidden
            className={cn(
              mark.text,
              "absolute left-0 text-[8px] leading-[22px]",
              inFold && "left-2"
            )}
          >
            {mark.glyph}
          </span>
          <span className="sr-only">{alertSide} sweep alert, </span>
        </>
      )}
      {Effect.runSync(tapeTime(DateTime.toEpochMillis(trade.time)))}
    </td>
  )
}

const TradeRow = memo(function TradeRow({
  trade,
  codes,
  selected,
  inFold,
  alertSide,
  onSelect,
}: {
  trade: RunningTrade
  codes: TradeCodes | undefined
  selected: boolean
  inFold: boolean
  // The side of the sweep alert the trade was part of.
  alertSide: AlertSide | undefined
  onSelect: (code: StockCode) => void
}) {
  const big = Effect.runSync(isBigTrade(trade))
  const side = SIDE_TEXT[trade.side]
  return (
    <tr
      data-trade-number={trade.tradeNumber}
      data-big={big || undefined}
      data-selected={selected || undefined}
      data-sweep-alert={alertSide}
      className={cn(
        big ? BIG_TINT[trade.side] : selected && "bg-selected",
        !big && !selected && inFold && "bg-elevated/40",
        big && "font-bold",
        "hover:bg-elevated cursor-pointer"
      )}
      // Clicking a trade selects its code; the code's button is the keyboard
      // and screen reader target.
      onClick={() => onSelect(trade.code)}
    >
      <TimeCell trade={trade} inFold={inFold} alertSide={alertSide} />
      <td className={cn(CELL, "font-semibold")}>
        <button type="button" className="hover:underline">
          {trade.code}
        </button>
        {trade.board !== "RG" && (
          <span className="ml-1 rounded-xs px-1 text-[10px] font-normal text-muted-foreground ring-1 ring-border">
            {trade.board}
          </span>
        )}
      </td>
      <td className={cn(CELL, "text-right", side)}>
        {Effect.runSync(plain(trade.price))}
        {trade.side !== "none" && (
          <span className="sr-only"> {trade.side}</span>
        )}
      </td>
      <td className={cn(CELL, "text-right", side)}>
        {Effect.runSync(lots(trade.lots))}
      </td>
      <td className={cn(CELL, "text-right", side)}>
        Rp{Effect.runSync(compact(Effect.runSync(tradeValue(trade))))}
      </td>
      <BrokerCells codes={codes} />
      <td className={cn(CELL, "pl-2")}>
        <SourceDots feeds={trade.feeds} />
      </td>
    </tr>
  )
})

const count = (n: number, noun: string) =>
  Effect.map(plain(n), (figure) => `${figure} ${noun}${n === 1 ? "" : "s"}`)

function FoldRow({
  row,
  open,
  onToggle,
}: {
  row: Extract<TapeRow, { kind: "fold" }>
  open: boolean
  onToggle: (match: AuctionMatch) => void
}) {
  return (
    <tr data-fold={row.match} className="bg-info/10 text-info">
      <td colSpan={COLUMNS} className={cn(CELL, "px-0")}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(row.match)}
          className="flex h-[22px] w-full items-center gap-2 px-2 text-left"
        >
          <span aria-hidden>{open ? "▾" : "▸"}</span>
          {row.live && (
            <span className="bg-info size-1.5 animate-pulse rounded-full">
              <span className="sr-only">Live</span>
            </span>
          )}
          <span className="font-semibold">{MATCH_LABEL[row.match]}</span>
          <span>
            {Effect.runSync(count(row.trades, "trade"))} · Rp
            {Effect.runSync(compact(row.value))} ·{" "}
            {Effect.runSync(count(row.codes, "code"))}
          </span>
        </button>
      </td>
    </tr>
  )
}

// A relay gap: one "not recorded" row over the stretch.
function GapRow({ gap }: { gap: RelayGap }) {
  return (
    <tr data-relay-gap className="text-muted-foreground">
      <td colSpan={COLUMNS} className={cn(CELL, "text-center")}>
        Not recorded ·{" "}
        {Effect.runSync(tapeTime(DateTime.toEpochMillis(gap.from)))}–
        {gap.to === undefined
          ? "now"
          : Effect.runSync(tapeTime(DateTime.toEpochMillis(gap.to)))}
      </td>
    </tr>
  )
}

// Stands in for `rows` rows outside the view, so the list scrolls the whole
// tape.
function Spacer({ rows }: { rows: number }) {
  if (rows <= 0) return null
  return <tr aria-hidden style={{ height: rows * ROW_PX }} />
}

// The tape as a virtual list: only the rows in view are DOM. A live tape
// follows live at the top; scrolled down it holds the tape as it was and
// counts what arrived since. A recorded tape is whole as of the replay
// cursor, and each move of the cursor replaces it, so it never holds; one
// shorter than the distance scrolled is viewed from its end.
export function TapeList({
  tape,
  frame,
  live = false,
  codes,
  selected,
  onSelect,
  gaps = [],
  className,
}: {
  tape: Tape
  // Changes once per drawn frame: the tape is mutated in place.
  frame: number
  live?: boolean
  // Each trade's broker codes, by Trade number; the live tape has none.
  codes?: RecordedTradeCodes
  selected: StockCode
  // Stable across renders, or every visible row re-renders.
  onSelect: (code: StockCode) => void
  // Each drawn as a row where it fell; not counted in the scroll height.
  gaps?: ReadonlyArray<RelayGap>
  className?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const [frozen, setFrozen] = useState<Tape | undefined>(undefined)
  const [open, setOpen] = useState<ReadonlySet<AuctionMatch>>(new Set())

  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null) return
    setHeight(element.clientHeight)
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onScroll = () => {
    const top = scroller.current?.scrollTop ?? 0
    setScrollTop(top)
    if (!live || top <= ROW_PX) setFrozen(undefined)
    else setFrozen((held) => held ?? Effect.runSync(freezeTape(tape)))
  }

  const backToLive = () => {
    scroller.current?.scrollTo({ top: 0 })
    setScrollTop(0)
    setFrozen(undefined)
  }

  const toggle = useCallback(
    (match: AuctionMatch) =>
      setOpen((current) => {
        const next = new Set(current)
        if (!next.delete(match)) next.add(match)
        return next
      }),
    []
  )

  const view = frozen ?? tape
  const total = Effect.runSync(tapeLength(view, open))
  // The scrolled distance, held to the tape: a shorter tape (the replay
  // cursor moved earlier) would otherwise put every row above the viewport.
  const top = Math.min(scrollTop, Math.max(0, total * ROW_PX - height))
  const first = Math.max(0, Math.floor(top / ROW_PX) - OVERSCAN)
  const last = Math.min(total, Math.ceil((top + height) / ROW_PX) + OVERSCAN)
  const rows = Effect.runSync(
    withGapRows(Effect.runSync(tapeRows(view, open, first, last)), gaps, {
      top: first === 0,
      bottom: last >= total,
    })
  )
  const unseen =
    frozen === undefined ? 0 : Math.max(0, tape.received - frozen.received)

  return (
    <div className={cn("relative", className)} data-frame={frame}>
      <div
        ref={scroller}
        onScroll={onScroll}
        // Relative, so the rows' absolute sr-only spans clip here;
        // otherwise the overscan rows under the fold lengthen the page.
        className="relative h-full overflow-auto overscroll-contain"
      >
        <table
          className="w-full table-fixed text-[13px] tabular-nums"
          style={{ minWidth: TAPE_WIDTH_PX }}
        >
          <colgroup>
            {Object.entries(COLUMN_PX).map(([column, px]) => (
              <col key={column} style={{ width: px }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card text-left text-muted-foreground">
            <tr>
              <th className="pl-2 font-normal">Time</th>
              <th className="font-normal">Code</th>
              <th className="text-right font-normal">Price</th>
              <th className="text-right font-normal">Lot</th>
              <th className="text-right font-normal">Value</th>
              <th className="pl-2 font-normal">Buyer</th>
              <th className="pl-2 font-normal">Seller</th>
              <th className="font-normal">
                <span className="sr-only">Source</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <Spacer rows={first} />
            {rows.map((row) =>
              row.kind === "gap" ? (
                <GapRow
                  key={`gap:${DateTime.toEpochMillis(row.gap.from)}`}
                  gap={row.gap}
                />
              ) : row.kind === "fold" ? (
                <FoldRow
                  key={`fold:${row.match}`}
                  row={row}
                  open={open.has(row.match)}
                  onToggle={toggle}
                />
              ) : (
                <TradeRow
                  key={row.trade.tradeNumber}
                  trade={row.trade}
                  codes={codes?.get(row.trade.tradeNumber)}
                  selected={row.trade.code === selected}
                  inFold={row.inFold !== undefined}
                  alertSide={
                    live
                      ? view.alertSides.get(row.trade.tradeNumber)
                      : undefined
                  }
                  onSelect={onSelect}
                />
              )
            )}
            <Spacer rows={total - last} />
          </tbody>
        </table>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={backToLive}
          className="absolute top-8 left-1/2 z-20 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground shadow-popover"
        >
          {Effect.runSync(plain(unseen))} new trades ↑
        </button>
      )}
    </div>
  )
}
