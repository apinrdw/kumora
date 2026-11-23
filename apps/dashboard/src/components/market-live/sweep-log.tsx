import { fetchRecordedSweeps, followSweepBrokers } from "@workspace/client"
import {
  INDEX_CODES,
  type BrokerCode,
  type StockCode,
  type Sweep,
  type SweepBroker,
  type SweepBrokers,
  type SweepOrders,
  type SweepPiece,
  type TradeNumber,
  type WibDate,
} from "@workspace/relay"
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
  arrivingNote,
  brokerPicks,
  emptyNote,
  isBigSweep,
  leadBroker,
  logRows,
  pricePath,
  sweepsUpTo,
  thresholdText,
  type KeptSweep,
  type LogRow,
  type SweepThreshold,
} from "@/lib/sweeps"

import { runLoad } from "./recorded-day"
import type { ReplayCursor } from "./replay-cursor"
import { makeSweepStore, type SweepStore } from "./sweep-store"
import { SweepTip } from "./sweep-tip"
import { INVESTOR_TEXT } from "./investor-text"

// The sweeps and the instant the page shows them at: a recorded day's
// cursor, or live the end of time.
interface SweepView {
  // The sweeps with each whole one swapped for its pieces.
  readonly sweeps: ReadonlyArray<Sweep>
  // The sweeps the broker filter keeps, with their own lots.
  readonly kept: ReadonlyArray<KeptSweep>
  readonly picked: BrokerCode | undefined
  readonly pieces: ReadonlyMap<TradeNumber, SweepPiece>
  // The sweeps as grouped before any split, and the entries of those whole.
  readonly grouped: ReadonlyArray<Sweep>
  readonly entries: ReadonlyMap<TradeNumber, SweepBrokers>
  // Whether the day's codes are complete; each answer that says so brings
  // new `pieces` too.
  readonly brokersComplete: boolean
  readonly brokersAskedAgain: boolean
  readonly at: number
  readonly threshold: SweepThreshold
  readonly topN: number
  readonly selected: TradeNumber | undefined
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
    const kept = store.kept()
    const pieces = store.pieces()
    const topN = store.topN()
    const selected = store.selected()
    const before = cached.current
    if (
      before?.sweeps === sweeps &&
      before.kept === kept &&
      before.pieces === pieces &&
      before.at === at &&
      before.topN === topN &&
      before.selected === selected
    )
      return before
    cached.current = {
      sweeps,
      kept,
      picked: store.picked(),
      pieces,
      grouped: store.grouped(),
      entries: store.entries(),
      brokersComplete: store.brokersComplete(),
      brokersAskedAgain: store.brokersAskedAgain(),
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
 * `day`: undefined live, where it loads today's again each time the store
 * asks (each snapshot of the code), the deltas carrying each minute that
 * changes since; a recorded day's loads once, whole. An index asks for none.
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
    // An index has no aggressor sides, so no sweeps to ask for.
    if (INDEX_CODES.includes(store.code)) return
    const stops: Array<() => void> = []
    const ask = (asking: number) =>
      stops.push(
        runLoad(
          Effect.map(fetchRecordedSweeps(date, store.code), (answer) => {
            if (Option.isSome(answer)) store.answer(asking, answer.value)
          })
        )
      )
    if (!live) {
      ask(0)
      stops.push(
        runLoad(followSweepBrokers(date, store.code, store.answerBrokers))
      )
    }
    let asked: number | undefined
    const stopStore = live
      ? store.subscribe(() => {
          const asking = store.awaiting()
          if (asking === undefined || asking === asked) return
          asked = asking
          ask(asking)
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
 * The candle chart's top-N filter: presets and a slider in 5% steps, applied
 * while it is dragged, and the threshold they come to.
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
        {Effect.runSync(thresholdText(view.threshold, view.picked))}
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

// The log's columns: live, and on a recorded day, whose sweeps can have
// brokers, with Value wide enough for `Rp325.91 M` and the Buyer and Seller
// columns for `XL [D] ×123`.
const COLUMNS = {
  live: "grid-cols-[58px_44px_minmax(0,1fr)_64px_10px]",
  brokers: "grid-cols-[58px_44px_minmax(0,1fr)_76px_80px_80px_10px]",
} as const

// A recorded day's columns scroll sideways inside a log narrower
// than they need, as the tape does (tape-list.tsx): a phone's Sweeps tab
// (about 360 px), and from lg a log given way below 530 px (layout-b.tsx).
// Time to Seller need about 520 px with the lots and price path whole.
const BROKER_COLUMNS_MIN = "min-w-[528px]"

// Shows the sweep tooltip at a broker cell, pinned for a click or a tap, or
// hides it.
type OnTip = (
  id: TradeNumber,
  cell: HTMLElement | undefined,
  pin?: boolean
) => void

// One side's Lead broker as `AK [F]` in its investor type's colour, and a
// muted `+N` for the others on that side, and after an order run's aggressor
// of 2 or more orders a muted `×N`; blank for a sweep not yet whole.
// Hovering it, or tapping it, shows the sweep's tooltip.
function LeadBrokerCell({
  id,
  column,
  side,
  orders,
  onTip,
}: {
  id: TradeNumber
  column: "buyer" | "seller"
  side: ReadonlyArray<SweepBroker> | undefined
  // The piece's order run, on its aggressor side's cell only.
  orders?: SweepOrders | undefined
  onTip: OnTip
}) {
  const lead = side && Effect.runSync(leadBroker(side))
  return (
    <span
      data-column={column}
      className="truncate"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") onTip(id, event.currentTarget)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") onTip(id, undefined)
      }}
      // A click or a tap pins it as the press lifts, after the press hid
      // the last one.
      onPointerUp={(event) => onTip(id, event.currentTarget, true)}
    >
      {lead && (
        <>
          <span className={INVESTOR_TEXT[lead.investorType]}>
            {lead.code} [{lead.investorType}]
          </span>
          {lead.more > 0 && (
            <span className="text-muted-foreground"> +{lead.more}</span>
          )}
          {orders !== undefined && orders.count >= 2 && (
            <span className="text-muted-foreground"> ×{orders.count}</span>
          )}
        </>
      )}
    </span>
  )
}

// A row's Buyer and Seller cells. A sell sweep's aggressor sold, so it takes
// Seller; a buy sweep's bought, as did an auction match's buyers, which its
// piece holds as `aggressor`, so they take Buyer.
function BuyerSellerCells({
  row,
  piece,
  onTip,
}: {
  row: LogRow
  piece: SweepPiece | undefined
  onTip: OnTip
}) {
  const sold = row.side === "sell"
  const aggressor = (
    <LeadBrokerCell
      id={row.firstTrade}
      column={sold ? "seller" : "buyer"}
      side={piece?.aggressor}
      orders={piece?.orders}
      onTip={onTip}
    />
  )
  const other = (
    <LeadBrokerCell
      id={row.firstTrade}
      column={sold ? "buyer" : "seller"}
      side={piece?.other}
      onTip={onTip}
    />
  )
  return sold ? (
    <>
      {other}
      {aggressor}
    </>
  ) : (
    <>
      {aggressor}
      {other}
    </>
  )
}

const LogRowView = memo(function LogRowView({
  row,
  withBrokers,
  filtered,
  piece,
  selected,
  onPick,
  onTip,
}: {
  row: LogRow
  // Whether the log has broker columns: on a recorded day, not live.
  withBrokers: boolean
  // Whether a broker is picked: the lots read `own/whole`.
  filtered: boolean
  // The row's piece, with its brokers; undefined until its sweep is whole.
  piece: SweepPiece | undefined
  selected: boolean
  onPick: (id: TradeNumber) => void
  onTip: OnTip
}) {
  const path = Effect.runSync(pricePath(row))
  return (
    <li style={{ height: ROW_HEIGHT }}>
      <button
        type="button"
        data-sweep-id={row.firstTrade}
        data-side={row.side}
        data-big={row.big || undefined}
        aria-current={selected || undefined}
        title={`${row.trades} trades`}
        onClick={() => onPick(row.firstTrade)}
        className={cn(
          "grid h-full w-full items-center gap-1.5 px-2.5 text-left font-mono text-[12px] whitespace-nowrap",
          withBrokers ? COLUMNS.brokers : COLUMNS.live,
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
          {filtered && <>{Effect.runSync(lots(row.own))}/</>}
          {Effect.runSync(lots(row.lots))} @ {path}
        </span>
        <span className="text-right">
          Rp{Effect.runSync(compact(row.value))}
        </span>
        {withBrokers && (
          <BuyerSellerCells row={row} piece={piece} onTip={onTip} />
        )}
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

// The broker filter: All brokers, then the aggressor brokers up to the
// cursor as `AK [F] · 12.4 K`, largest first. Live no sweep has brokers, so
// it is disabled.
function BrokerFilter({
  store,
  view,
  withBrokers,
}: {
  store: SweepStore
  view: SweepView
  withBrokers: boolean
}) {
  const picks = useMemo(
    () => Effect.runSync(brokerPicks(view.sweeps, view.pieces, view.at)),
    [view.sweeps, view.pieces, view.at]
  )
  // A picked broker the cursor moved back before stays listed, so the
  // control still names it.
  const listed =
    view.picked === undefined || picks.some((pick) => pick.code === view.picked)
  return (
    <select
      aria-label="Broker filter"
      disabled={!withBrokers}
      value={view.picked ?? ""}
      onChange={(event) =>
        store.pick(picks.find((pick) => pick.code === event.target.value)?.code)
      }
      className="bg-surface ml-auto max-w-40 rounded-md border border-border px-1 py-px font-mono text-[11px] font-normal text-foreground disabled:opacity-50"
    >
      <option value="">
        {/* Decision: "after the close" is the owner's approved copy for after the Seal
            (apps/dashboard/docs/adr/0026-after-the-close-is-the-approved-copy-for-post-seal-arrivals.md) */}
        {withBrokers ? "All brokers" : "Brokers after the close"}
      </option>
      {!listed && <option value={view.picked}>{view.picked}</option>}
      {picks.map((pick) => (
        <option key={pick.code} value={pick.code}>
          {pick.code} [{pick.investorType}] ·{" "}
          {Effect.runSync(compact(pick.lots))}
        </option>
      ))}
    </select>
  )
}

// While the day's codes are incomplete, how many sweeps up to the cursor,
// as grouped before any split, have their brokers yet.
function ArrivingNote({ view }: { view: SweepView }) {
  const note = useMemo(
    () =>
      Effect.runSync(
        arrivingNote(
          view.grouped,
          view.entries,
          view.at,
          view.brokersAskedAgain
        )
      ),
    [view.grouped, view.entries, view.at, view.brokersAskedAgain]
  )
  if (view.brokersComplete) return null
  return (
    <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
      {note}
    </p>
  )
}

/**
 * The Buy/Sell sweep log (layout B's middle column): the selected code's
 * sweeps up to the cursor, newest first, filtered by the picked broker, the
 * top-N threshold and the Big only toggle (`bigOnly`), auction matches as
 * neutral rows. Clicking a row selects its sweep, which jumps the candle chart
 * there; a bubble picked on the candle chart scrolls its row into view.
 */
export function SweepLog({
  store,
  cursor,
  withBrokers,
  bigOnly,
  onBigOnly,
}: {
  store: SweepStore
  cursor?: ReplayCursor | undefined
  // Whether the shown day can have broker codes: a recorded day. Its log
  // gains the broker columns.
  withBrokers: boolean
  // The Big only toggle, kept by the page in its URL.
  bigOnly: boolean
  onBigOnly: (on: boolean) => void
}) {
  const view = useSweepView(store, cursor)
  const empty = useMemo(
    () => Effect.runSync(emptyNote(view.kept, view.picked, view.at)),
    [view.kept, view.picked, view.at]
  )
  const rows = useMemo(
    () =>
      Effect.runSync(
        logRows(view.kept, {
          threshold: view.threshold.lots,
          bigOnly,
          at: view.at,
        })
      ),
    [view.kept, view.threshold, view.at, bigOnly]
  )
  const counts = useMemo(() => {
    let buy = 0
    let sell = 0
    let big = 0
    for (const sweep of Effect.runSync(sweepsUpTo(view.kept, view.at))) {
      if (sweep.side === "buy") buy += 1
      else if (sweep.side === "sell") sell += 1
      else continue
      if (Effect.runSync(isBigSweep(sweep))) big += 1
    }
    return { buy, sell, big }
  }, [view.kept, view.at])
  // `contain: size` at every width, so the log adds no height to
  // its grid row: a busy code's thousands of rows scroll inside it instead
  // of stretching both charts beside it (from lg, apinrdw/kumora#272) or
  // its phone tab (below lg) to thousands of px. Below lg it is its
  // 420 px minimum.
  return (
    <section
      aria-label="Sweep log"
      className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card contain-size"
    >
      <header className="border-b border-border px-2.5 pt-2 pb-1.5">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
          <h2>Buy/Sell sweeps · {store.code}</h2>
          <BrokerFilter store={store} view={view} withBrokers={withBrokers} />
          <button
            type="button"
            aria-pressed={bigOnly}
            onClick={() => onBigOnly(!bigOnly)}
            className={cn(
              "rounded-md border border-border px-1.5 py-px text-[11px] font-normal",
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
        {withBrokers && <ArrivingNote view={view} />}
      </header>
      <LogColumns
        store={store}
        view={view}
        rows={rows}
        empty={empty}
        withBrokers={withBrokers}
      />
      <SweepTip store={store} cursor={cursor} withBrokers={withBrokers} />
    </section>
  )
}

// The log's column heads and its rows, drawn only around the visible ones,
// or `empty` when none shows. Clicking a row selects its sweep; a bubble
// picked on the candle chart scrolls its row to the middle.
function LogColumns({
  store,
  view,
  rows,
  empty,
  withBrokers,
}: {
  store: SweepStore
  view: SweepView
  rows: ReadonlyArray<LogRow>
  empty: string | undefined
  withBrokers: boolean
}) {
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
  // A bubble picked on the candle chart scrolls its row to the middle.
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
        const index = rowsRef.current.findIndex(
          (row) => row.firstTrade === change.id
        )
        if (index < 0) return
        element.scrollTop = Math.max(
          0,
          index * ROW_HEIGHT - element.clientHeight / 2
        )
      }),
    [store]
  )
  const pick = useCallback(
    (id: TradeNumber) => store.select(id, "log"),
    [store]
  )
  const showTip = useCallback<OnTip>(
    (id, cell, pin = false) => {
      if (!pin && store.tip.get()?.pinned) return
      if (cell === undefined) return store.tip.set(undefined)
      const box = cell.getBoundingClientRect()
      store.tip.set({
        id,
        x: box.left,
        y: box.bottom,
        from: "log",
        pinned: pin,
      })
    },
    [store]
  )
  const first = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(
    rows.length,
    Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN
  )
  return (
    <div className="flex min-h-0 flex-1 overflow-x-auto">
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          withBrokers && BROKER_COLUMNS_MIN
        )}
      >
        <div
          aria-hidden
          className={cn(
            "grid gap-1.5 border-b border-border px-2.5 py-1 text-[10px] tracking-[0.06em] text-muted-foreground uppercase",
            withBrokers ? COLUMNS.brokers : COLUMNS.live
          )}
        >
          <span>Time</span>
          <span>Side</span>
          <span>Lots @ price</span>
          <span className="text-right">Value</span>
          {withBrokers && <span>Buyer</span>}
          {withBrokers && <span>Seller</span>}
          <span />
        </div>
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
          {empty !== undefined && rows.length === 0 && (
            <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
              {empty}
            </p>
          )}
          <div
            className="relative"
            style={{ height: rows.length * ROW_HEIGHT }}
          >
            <ol
              aria-label="Sweeps, newest first"
              className="absolute inset-x-0"
              style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}
            >
              {rows.slice(first, last).map((row) => (
                <LogRowView
                  key={row.firstTrade}
                  row={row}
                  withBrokers={withBrokers}
                  filtered={view.picked !== undefined}
                  piece={view.pieces.get(row.firstTrade)}
                  selected={row.firstTrade === view.selected}
                  onPick={pick}
                  onTip={showTip}
                />
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
