import type { RunningTrade, StockCode, ViewerDown } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { DateTime } from "effect"
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { compact, plain, tapeTime } from "@/lib/format"
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

// The page's tape as an external store, drawn at most once per animation
// frame however many deltas arrive in it: each message goes into the tape at
// once, and the next frame tells React to draw them all.
function framedTapeStore() {
  let tape = emptyTape()
  let frame = 0
  let scheduled: number | undefined
  const listeners = new Set<() => void>()
  return {
    apply: (message: ViewerDown) => {
      tape = applyViewerMessage(tape, message)
      if (scheduled !== undefined) return
      scheduled = requestAnimationFrame(() => {
        scheduled = undefined
        frame += 1
        for (const listener of listeners) listener()
      })
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
}

export function useFramedTape() {
  const [store] = useState(framedTapeStore)
  const frame = useSyncExternalStore(store.subscribe, store.frame, store.frame)
  return { tape: store.tape(), frame, apply: store.apply }
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

const TradeRow = memo(function TradeRow({
  trade,
  selected,
  inFold,
}: {
  trade: RunningTrade
  selected: boolean
  inFold: boolean
}) {
  const big = isBigTrade(trade)
  const side = SIDE_TEXT[trade.side]
  return (
    <tr
      data-trade-number={trade.tradeNumber}
      data-big={big || undefined}
      data-selected={selected || undefined}
      className={cn(
        big ? BIG_TINT[trade.side] : selected && "bg-selected",
        !big && !selected && inFold && "bg-elevated/40",
        big && "font-bold"
      )}
    >
      <td className={cn(CELL, "pl-2", inFold && "pl-4")}>
        {tapeTime(DateTime.toEpochMillis(trade.time))}
      </td>
      <td className={cn(CELL, "font-semibold")}>
        {trade.code}
        {trade.board !== "RG" && (
          <span className="ml-1 rounded-xs px-1 text-[10px] font-normal text-muted-foreground ring-1 ring-border">
            {trade.board}
          </span>
        )}
      </td>
      <td className={cn(CELL, "text-right", side)}>
        {plain(trade.price)}
        {trade.side !== "none" && (
          <span className="sr-only"> {trade.side}</span>
        )}
      </td>
      <td className={cn(CELL, "text-right", side)}>
        {plain(trade.lots, Number.isInteger(trade.lots) ? 0 : 1)}
      </td>
      <td className={cn(CELL, "text-right", side)}>
        Rp{compact(tradeValue(trade))}
      </td>
      <td className={cn(CELL, "pl-2")}>
        <SourceDots feeds={trade.feeds} />
      </td>
    </tr>
  )
})

const count = (n: number, noun: string) =>
  `${plain(n)} ${noun}${n === 1 ? "" : "s"}`

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
      <td colSpan={6} className={cn(CELL, "px-0")}>
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
            {count(row.trades, "trade")} · Rp{compact(row.value)} ·{" "}
            {count(row.codes, "code")}
          </span>
        </button>
      </td>
    </tr>
  )
}

// The tape as a virtual list: only the rows in view are DOM. At the top it
// follows live; scrolled down it holds the tape as it was and counts what
// arrived since.
export function TapeList({
  tape,
  frame,
  selected,
  className,
}: {
  tape: Tape
  // Changes once per drawn frame: the tape is mutated in place.
  frame: number
  selected: StockCode
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
    if (top <= ROW_PX) setFrozen(undefined)
    else setFrozen((held) => held ?? freezeTape(tape))
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
  const total = tapeLength(view, open)
  const first = Math.max(0, Math.floor(scrollTop / ROW_PX) - OVERSCAN)
  const last = Math.min(
    total,
    Math.ceil((scrollTop + height) / ROW_PX) + OVERSCAN
  )
  const rows = tapeRows(view, open, first, last)
  const unseen =
    frozen === undefined ? 0 : Math.max(0, tape.received - frozen.received)

  return (
    <div className={cn("relative", className)} data-frame={frame}>
      <div
        ref={scroller}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain"
      >
        <table className="w-full table-fixed text-[13px] tabular-nums">
          <colgroup>
            <col className="w-[76px]" />
            <col className="w-[84px]" />
            <col />
            <col />
            <col />
            <col className="w-[36px]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card text-left text-muted-foreground">
            <tr>
              <th className="pl-2 font-normal">Time</th>
              <th className="font-normal">Code</th>
              <th className="text-right font-normal">Price</th>
              <th className="text-right font-normal">Lot</th>
              <th className="text-right font-normal">Value</th>
              <th className="font-normal">
                <span className="sr-only">Source</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {first > 0 && <tr aria-hidden style={{ height: first * ROW_PX }} />}
            {rows.map((row) =>
              row.kind === "fold" ? (
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
                  selected={row.trade.code === selected}
                  inFold={row.inFold !== undefined}
                />
              )
            )}
            {last < total && (
              <tr aria-hidden style={{ height: (total - last) * ROW_PX }} />
            )}
          </tbody>
        </table>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={backToLive}
          className="absolute top-8 left-1/2 z-20 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground shadow-popover"
        >
          {plain(unseen)} new trades ↑
        </button>
      )}
    </div>
  )
}
