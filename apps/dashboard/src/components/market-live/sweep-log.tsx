import { fetchRecordedSweeps } from "@workspace/client"
import type { StockCode, Sweep, WibDate } from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { cn } from "@workspace/ui/lib/utils"

import { compact, lots, plain, tapeTime } from "@/lib/format"
import {
  TOP_N_PRESETS,
  isBigSweep,
  logRows,
  thresholdText,
  type LogRow,
  type SweepThreshold,
} from "@/lib/sweeps"

import { runLoad } from "./recorded-day"
import type { ReplayCursor } from "./replay-cursor"
import { makeSweepStore, type SweepStore } from "./sweep-store"

// The sweeps and the instant the page shows them at: a recorded day's
// cursor, or live the end of time.
interface SweepView {
  readonly sweeps: ReadonlyArray<Sweep>
  readonly at: number
  readonly threshold: SweepThreshold
  readonly topN: number
  readonly selected: number | undefined
}

// The store's view at the cursor, the same object until something in it
// changes, so React re-renders only then.
function useSweepView(store: SweepStore, cursor: ReplayCursor | undefined) {
  const cached = useRef<SweepView | undefined>(undefined)
  const subscribe = useCallback(
    (listener: () => void) => {
      const stopStore = store.subscribe(listener)
      const stopCursor = cursor?.subscribe(listener)
      return () => {
        stopStore()
        stopCursor?.()
      }
    },
    [store, cursor]
  )
  const read = () => {
    const at =
      cursor === undefined ? Number.POSITIVE_INFINITY : cursor.state().at
    const sweeps = store.sweeps()
    const topN = store.topN()
    const selected = store.selected()
    const before = cached.current
    if (
      before?.sweeps === sweeps &&
      before.at === at &&
      before.topN === topN &&
      before.selected === selected
    )
      return before
    cached.current = {
      sweeps,
      at,
      threshold: store.threshold(at),
      topN,
      selected,
    }
    return cached.current
  }
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * The selected code's sweep store, one per code, loaded from its GET for
 * `day`: undefined live, where it loads today's again after each snapshot of
 * the code, the store holding the delta trades until the answer lands; a
 * recorded day's loads once, whole.
 */
export function useSweeps(
  selected: StockCode,
  day: WibDate | undefined,
  today: WibDate
) {
  const store = useMemo(
    () => Effect.runSync(makeSweepStore(selected)),
    [selected]
  )
  const live = day === undefined
  const date = day ?? today
  useEffect(() => {
    const stops: Array<() => void> = []
    const ask = (snapshot: number) =>
      stops.push(
        runLoad(
          Effect.map(fetchRecordedSweeps(date, store.code), (answer) => {
            if (Option.isSome(answer)) store.answer(snapshot, answer.value)
          })
        )
      )
    if (!live) ask(0)
    let asked: number | undefined
    const stopStore = live
      ? store.subscribe(() => {
          const snapshot = store.awaiting()
          if (snapshot === undefined || snapshot === asked) return
          asked = snapshot
          ask(snapshot)
        })
      : undefined
    return () => {
      stopStore?.()
      for (const stop of stops) stop()
    }
  }, [store, date, live])
  return store
}

/**
 * Chart 1's top-N filter: presets and a slider in 5% steps, applied while it
 * is dragged, and the threshold they come to.
 */
export function TopNControl({
  store,
  cursor,
}: {
  store: SweepStore
  cursor?: ReplayCursor | undefined
}) {
  const view = useSweepView(store, cursor)
  return (
    <div
      role="group"
      aria-label="Top sweeps"
      className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground"
    >
      <span>Show top</span>
      {TOP_N_PRESETS.map((percent) => (
        <button
          key={percent}
          type="button"
          aria-pressed={view.topN === percent}
          onClick={() => store.setTopN(percent)}
          className={cn(
            "rounded-md border border-border px-1.5 py-px",
            view.topN === percent
              ? "border-primary text-primary"
              : "hover:bg-elevated"
          )}
        >
          {percent === 100 ? "All" : `${percent}%`}
        </button>
      ))}
      <input
        type="range"
        min={5}
        max={100}
        step={5}
        value={Math.max(5, view.topN)}
        aria-label="Top N percent of sweeps"
        onChange={(event) => store.setTopN(Number(event.target.value))}
        className="mx-1 w-24 accent-primary"
      />
      <b className="min-w-8 text-foreground tabular-nums">
        {view.topN === 100 ? "All" : `${view.topN}%`}
      </b>
      <span aria-label="Sweep threshold" className="tabular-nums">
        {Effect.runSync(thresholdText(view.threshold))}
      </span>
    </div>
  )
}

const ROW_HEIGHT = 24
// Rows drawn beyond the visible ones on each side.
const OVERSCAN = 4

const SIDE = {
  buy: { label: "Buy", tone: "text-up" },
  sell: { label: "Sell", tone: "text-down" },
  none: { label: "Auction", tone: "text-muted-foreground" },
} as const

const LogRowView = memo(function LogRowView({
  row,
  selected,
  onPick,
}: {
  row: LogRow
  selected: boolean
  onPick: (id: number) => void
}) {
  const path =
    row.first === row.last
      ? Effect.runSync(plain(row.first))
      : `${Effect.runSync(plain(row.first))}→${Effect.runSync(plain(row.last))}`
  return (
    <li style={{ height: ROW_HEIGHT }}>
      <button
        type="button"
        data-sweep-id={row.id}
        data-side={row.side}
        data-big={row.big || undefined}
        aria-current={selected || undefined}
        title={`${row.trades} trades`}
        onClick={() => onPick(row.id)}
        className={cn(
          "grid h-full w-full grid-cols-[58px_44px_minmax(0,1fr)_64px_10px] items-center gap-1.5 px-2.5 text-left font-mono text-[12px] whitespace-nowrap",
          row.big && "bg-warning/10",
          selected
            ? "bg-selected shadow-[inset_3px_0_0_var(--accent-primary)]"
            : "hover:bg-elevated"
        )}
      >
        <span>
          {Effect.runSync(tapeTime(DateTime.toEpochMillis(row.time)))}
        </span>
        <span className={SIDE[row.side].tone}>{SIDE[row.side].label}</span>
        <span className="truncate">
          {Effect.runSync(lots(row.lots))} @ {path}
        </span>
        <span className="text-right">
          Rp{Effect.runSync(compact(row.value))}
        </span>
        <span className="text-warning">
          {row.big && (
            <>
              <span aria-hidden>◆</span>
              <span className="sr-only">Big trade</span>
            </>
          )}
        </span>
      </button>
    </li>
  )
})

/**
 * The Buy/Sell sweep log (layout B's middle column): the selected code's
 * sweeps up to the cursor, newest first, filtered by the top-N threshold and
 * the Big only toggle (`bigOnly`), auction matches as neutral rows. Clicking a row
 * selects its sweep, which jumps chart 1 there; a bubble picked on chart 1
 * scrolls its row into view.
 */
export function SweepLog({
  store,
  cursor,
  bigOnly,
  onBigOnly,
}: {
  store: SweepStore
  cursor?: ReplayCursor | undefined
  // The Big only toggle, kept by the page in its URL.
  bigOnly: boolean
  onBigOnly: (on: boolean) => void
}) {
  const view = useSweepView(store, cursor)
  const rows = useMemo(
    () =>
      Effect.runSync(
        logRows(view.sweeps, {
          threshold: view.threshold.lots,
          bigOnly,
          at: view.at,
        })
      ),
    [view.sweeps, view.threshold, view.at, bigOnly]
  )
  const counts = useMemo(() => {
    let buy = 0
    let sell = 0
    let big = 0
    for (const sweep of view.sweeps) {
      if (DateTime.toEpochMillis(sweep.time) > view.at) continue
      if (sweep.side === "buy") buy += 1
      else if (sweep.side === "sell") sell += 1
      else continue
      if (Effect.runSync(isBigSweep(sweep))) big += 1
    }
    return { buy, sell, big }
  }, [view.sweeps, view.at])
  const scroller = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 0 })
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const measure = () =>
      setScroll({ top: element.scrollTop, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element.addEventListener("scroll", measure, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener("scroll", measure)
    }
  }, [])
  // A bubble picked on chart 1 scrolls its row to the middle.
  const rowsRef = useRef(rows)
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])
  useEffect(
    () =>
      store.subscribe((change) => {
        const element = scroller.current
        if (change._tag !== "Selected" || change.from !== "chart") return
        if (element === null) return
        const index = rowsRef.current.findIndex((row) => row.id === change.id)
        if (index < 0) return
        element.scrollTop = Math.max(
          0,
          index * ROW_HEIGHT - element.clientHeight / 2
        )
      }),
    [store]
  )
  const pick = useCallback((id: number) => store.select(id, "log"), [store])
  const first = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(
    rows.length,
    Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN
  )
  // Decision: `contain: size` in layout B, so the log adds no height to its
  // grid row: a busy code's thousands of rows scroll inside it instead of
  // stretching both charts beside it to thousands of px (apinrdw/kumora#272).
  return (
    <section
      aria-label="Sweep log"
      className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card lg:contain-size"
    >
      <header className="border-b border-border px-2.5 pt-2 pb-1.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <h2>Buy/Sell sweeps · {store.code}</h2>
          <button
            type="button"
            aria-pressed={bigOnly}
            onClick={() => onBigOnly(!bigOnly)}
            className={cn(
              "ml-auto rounded-md border border-border px-1.5 py-px text-[11px] font-normal",
              bigOnly ? "border-primary text-primary" : "hover:bg-elevated"
            )}
          >
            Big only
          </button>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
          {Effect.runSync(plain(counts.buy + counts.sell))} sweeps · Buy{" "}
          {Effect.runSync(plain(counts.buy))} · Sell{" "}
          {Effect.runSync(plain(counts.sell))} · Big {counts.big} ·{" "}
          <span aria-label="Rows shown">
            showing {Effect.runSync(plain(rows.length))}
          </span>
        </p>
      </header>
      <div
        aria-hidden
        className="grid grid-cols-[58px_44px_minmax(0,1fr)_64px_10px] gap-1.5 border-b border-border px-2.5 py-1 text-[10px] tracking-[0.06em] text-muted-foreground uppercase"
      >
        <span>Time</span>
        <span>Side</span>
        <span>Lots @ price</span>
        <span className="text-right">Value</span>
        <span />
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
          <ol
            aria-label="Sweeps, newest first"
            className="absolute inset-x-0"
            style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}
          >
            {rows.slice(first, last).map((row) => (
              <LogRowView
                key={row.id}
                row={row}
                selected={row.id === view.selected}
                onPick={pick}
              />
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
