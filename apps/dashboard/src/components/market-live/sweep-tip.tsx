// The one tooltip of the candle chart's bubbles and the sweep log's broker
// cells (spec apinrdw/kumora#343, "One tooltip"): the sweep, then every broker
// of each side with its lots, uncapped, the picked broker marked. A bubble or a
// cell sets where it shows (`SweepStore.tip`); a press outside it hides it, and
// so does the replay cursor moving back before its sweep.
import type { BrokerCode, Sweep, SweepBroker } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { DateTime, Effect } from "effect"
import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
} from "react"
import { createPortal } from "react-dom"

import { lots } from "@/lib/format"
import { sweepTip, type SweepTipText } from "@/lib/sweeps"

import type { ReplayCursor } from "./replay-cursor"
import type { SweepStore, TipAt } from "./sweep-store"
import { INVESTOR_TEXT } from "./investor-text"

// The tooltip sits this far from its point, on the side with more room,
// and at least this far inside the viewport's edges.
const GAP_PX = 12
const EDGE_PX = 8

// Where the tooltip sits for `at`, and its size limits.
// The list is uncapped, so the tooltip is held to the room on
// its side of the point and scrolls past it. A hover's tooltip takes no
// pointer, so it never covers what it describes; a click or a tap pins it
// and it takes the pointer, to scroll. See spec apinrdw/kumora#343, "One
// tooltip".
const placement = (at: TipAt) =>
  Effect.sync((): CSSProperties => {
    const right = at.x > window.innerWidth / 2
    const below = at.y < window.innerHeight / 2
    const width = Math.min(
      300,
      (right ? at.x : window.innerWidth - at.x) - GAP_PX - EDGE_PX
    )
    return {
      minWidth: Math.min(200, width),
      maxWidth: width,
      maxHeight: (below ? window.innerHeight - at.y : at.y) - GAP_PX - EDGE_PX,
      ...(right
        ? { right: window.innerWidth - at.x + GAP_PX }
        : { left: at.x + GAP_PX }),
      ...(below
        ? { top: at.y + GAP_PX }
        : { bottom: window.innerHeight - at.y + GAP_PX }),
    }
  })

// Each side's brokers with their lots, the picked broker marked.
function TipBrokers({
  sides,
  picked,
}: {
  sides: ReadonlyArray<{
    readonly label: string
    readonly brokers: ReadonlyArray<SweepBroker>
  }>
  picked: BrokerCode | undefined
}) {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {sides.map((side) => [
          <tr key={side.label}>
            <th
              colSpan={2}
              scope="colgroup"
              className="pt-1 text-left font-sans text-[10px] font-normal tracking-[0.06em] text-muted-foreground uppercase"
            >
              {side.label}
            </th>
          </tr>,
          ...side.brokers.map((broker) => (
            <tr key={`${side.label} ${broker.code}`}>
              <td className={INVESTOR_TEXT[broker.investorType]}>
                {broker.code} [{broker.investorType}]
                {/* The broker filter's pick, marked wherever listed. */}
                {broker.code === picked && " ◂"}
              </td>
              <td className="text-right">
                {Effect.runSync(lots(broker.lots))}
              </td>
            </tr>
          )),
        ])}
      </tbody>
    </table>
  )
}

// The tooltip's title, an order run's orders, then its brokers, or why
// there are none yet.
function TipBody({
  tip,
  picked,
  withBrokers,
}: {
  tip: SweepTipText
  picked: BrokerCode | undefined
  withBrokers: boolean
}) {
  return (
    <>
      <p className="mb-1 font-sans font-semibold">{tip.title}</p>
      {tip.orders !== undefined && (
        <p className="mb-1 text-muted-foreground">{tip.orders}</p>
      )}
      {tip.sides === undefined ? (
        <p className="text-muted-foreground">
          {/* Decision: "after the close" is the owner's approved copy for after the Seal
              (apps/dashboard/docs/adr/0026-after-the-close-is-the-approved-copy-for-post-seal-arrivals.md) */}
          {withBrokers
            ? "Brokers show once every trade in this sweep has its codes."
            : "Broker codes arrive after the close."}
        </p>
      ) : (
        <TipBrokers sides={tip.sides} picked={picked} />
      )}
    </>
  )
}

// Whether the shown sweep is after the cursor, as the bubbles and the log
// leave it out.
function useHiddenByCursor(
  store: SweepStore,
  cursor: ReplayCursor | undefined,
  sweep: Sweep | undefined
) {
  const subscribe = useCallback(
    (listener: () => void) => cursor?.subscribe(listener) ?? (() => {}),
    [cursor]
  )
  const past = () =>
    sweep !== undefined &&
    cursor !== undefined &&
    DateTime.toEpochMillis(sweep.time) > cursor.state().at
  const hidden = useSyncExternalStore(subscribe, past, past)
  useEffect(() => {
    // A tooltip whose sweep the cursor moved back before hides
    // for good, rather than following the cursor to another sweep or
    // showing again as the cursor passes it. See apinrdw/kumora#371.
    if (hidden) store.tip.set(undefined)
  }, [store, hidden])
  return hidden
}

export function SweepTip({
  store,
  cursor,
  withBrokers,
}: {
  store: SweepStore
  // A recorded day's replay cursor; none live.
  cursor?: ReplayCursor | undefined
  // Whether the shown day can have broker codes: a recorded day.
  withBrokers: boolean
}) {
  const at = useSyncExternalStore(
    store.tip.subscribe,
    store.tip.get,
    () => undefined
  )
  // What it shows of the sweep, redrawn while open as a recheck brings
  // its brokers or the filter's pick changes.
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store]
  )
  const sweeps = useSyncExternalStore(subscribe, store.sweeps, store.sweeps)
  const pieces = useSyncExternalStore(subscribe, store.pieces, store.pieces)
  const picked = useSyncExternalStore(subscribe, store.picked, store.picked)
  const sweep =
    at === undefined
      ? undefined
      : sweeps.find((held) => held.firstTrade === at.id)
  const hidden = useHiddenByCursor(store, cursor, sweep)
  const from = at?.from
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (from === undefined) return
    const hide = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) store.tip.set(undefined)
    }
    // A tap shows the next as its press lifts, after this press hid it.
    document.addEventListener("pointerdown", hide)
    // A scroll leaves a cell's tooltip behind. A bubble's stays: picking it
    // scrolls the log to its row.
    if (from === "log")
      window.addEventListener("scroll", hide, { capture: true, passive: true })
    return () => {
      document.removeEventListener("pointerdown", hide)
      window.removeEventListener("scroll", hide, { capture: true })
    }
  }, [store, from])
  if (at === undefined || sweep === undefined || hidden) return null
  const tip = Effect.runSync(sweepTip(sweep, pieces.get(at.id)))
  return createPortal(
    <div
      ref={box}
      role="tooltip"
      aria-label="Sweep brokers"
      className={cn(
        "border-strong fixed z-50 overflow-y-auto overscroll-contain rounded-md border bg-popover px-2 py-1.5 font-mono text-[11px] leading-snug tabular-nums shadow-lg",
        !at.pinned && "pointer-events-none"
      )}
      style={Effect.runSync(placement(at))}
    >
      <TipBody tip={tip} picked={picked} withBrokers={withBrokers} />
    </div>,
    document.body
  )
}
