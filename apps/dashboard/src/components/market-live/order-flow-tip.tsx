// The tooltip of a chart's order flow mark (spec apinrdw/kumora#605, "Order
// flow events: on the page"): the event's minute and title, then its
// figures. A mark sets where it shows (order-flow-marks.ts); a press outside
// it hides it.
import { DateTime, Effect } from "effect"
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { cn } from "@workspace/ui/lib/utils"

import { wibClock } from "@/lib/format"
import {
  marketEventKey,
  orderFlowEventFigures,
  orderFlowEventTitle,
} from "@/lib/order-flow-events"

import type { BookEventStore } from "./book-event-store"
import type { ListenerStore } from "./listener-store"
import type { OrderFlowTipAt } from "./order-flow-marks"

// The tooltip sits this far from its point, on the side with more room.
const GAP_PX = 12

export function OrderFlowTip({
  tip,
  store,
}: {
  tip: ListenerStore<OrderFlowTipAt | undefined>
  store: BookEventStore
}) {
  const at = useSyncExternalStore(tip.subscribe, tip.get, () => undefined)
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store]
  )
  const events = useSyncExternalStore(
    subscribe,
    store.orderFlowEvents,
    store.orderFlowEvents
  )
  const box = useRef<HTMLDivElement>(null)
  const pinned = at?.pinned === true
  useEffect(() => {
    if (!pinned) return
    const hide = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) tip.set(undefined)
    }
    // A tap shows the next as its press lifts, after this press hid it.
    document.addEventListener("pointerdown", hide)
    return () => document.removeEventListener("pointerdown", hide)
  }, [tip, pinned])
  const event =
    at === undefined
      ? undefined
      : events.find((each) => Effect.runSync(marketEventKey(each)) === at.key)
  if (at === undefined || event === undefined) return null
  const right = at.x > window.innerWidth / 2
  const below = at.y < window.innerHeight / 2
  return createPortal(
    <div
      ref={box}
      role="tooltip"
      aria-label="Order flow event"
      className={cn(
        "border-strong fixed z-50 max-w-[300px] rounded-md border bg-popover px-2 py-1.5 text-[11px] leading-snug shadow-lg",
        !pinned && "pointer-events-none"
      )}
      style={{
        ...(right
          ? { right: window.innerWidth - at.x + GAP_PX }
          : { left: at.x + GAP_PX }),
        ...(below
          ? { top: at.y + GAP_PX }
          : { bottom: window.innerHeight - at.y + GAP_PX }),
      }}
    >
      <p
        className={cn(
          "font-semibold",
          event.side === "buy" ? "text-up" : "text-down"
        )}
      >
        {Effect.runSync(wibClock(DateTime.toEpochMillis(event.at)))} ·{" "}
        {Effect.runSync(orderFlowEventTitle(event))}
      </p>
      <p className="font-mono text-muted-foreground tabular-nums">
        {Effect.runSync(orderFlowEventFigures(event))}
      </p>
    </div>,
    document.body
  )
}
