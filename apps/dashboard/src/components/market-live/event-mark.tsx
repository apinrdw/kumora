// How a row shows a market event (spec apinrdw/kumora#605, "Order flow
// events: on the page"): an order flow event as ▲ (buying) or ▼ (selling)
// in the aggressor side's colour with its kind's letter, a book event as its
// kind's chip. No row tags the event's family. The radar's feed and chips
// and the Book readout list use them.
import type { OrderFlowEvent } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { BOOK_EVENT_MARKS, BOOK_EVENT_NAMES } from "@/lib/book-events"
import {
  ORDER_FLOW_LETTERS,
  splitEvent,
  marketEventDetail,
  marketEventName,
  orderFlowEventTitle,
  type MarketEvent,
} from "@/lib/order-flow-events"

/** ▲E, ▼D: the side's triangle and the kind's letter, in the side's colour. */
function OrderFlowMark({ event }: { event: OrderFlowEvent }) {
  return (
    <span
      data-order-flow-mark={event.kind}
      className={cn(
        "font-bold whitespace-nowrap",
        event.side === "buy" ? "text-up" : "text-down"
      )}
    >
      {event.side === "buy" ? "▲" : "▼"}
      {ORDER_FLOW_LETTERS[event.kind]}
    </span>
  )
}

/** A row's name: an order flow event's mark and title, a book event's chip. */
export function EventName({ event }: { event: MarketEvent }) {
  const split = Effect.runSync(splitEvent(event))
  if (split._tag === "orderFlow")
    return (
      <span className="inline-flex items-baseline gap-1.5">
        <OrderFlowMark event={split.event} />
        <span className="font-semibold">
          {Effect.runSync(orderFlowEventTitle(split.event))}
        </span>
      </span>
    )
  const book = split.event
  return (
    <span
      className={cn(
        "rounded-xs px-1.5 text-[10px] font-bold whitespace-nowrap",
        book.side === "bid" ? "bg-up/15 text-up" : "bg-down/15 text-down"
      )}
    >
      {BOOK_EVENT_NAMES[book.kind]}
    </span>
  )
}

/** A scanner row's last-event chip: the mark alone, its name and detail on hover. */
export function EventChip({ event }: { event: MarketEvent }) {
  const title = `${Effect.runSync(marketEventName(event))}: ${Effect.runSync(marketEventDetail(event))}`
  const split = Effect.runSync(splitEvent(event))
  if (split._tag === "orderFlow")
    return (
      <abbr title={title} className="text-[9px] no-underline sm:text-[10px]">
        <OrderFlowMark event={split.event} />
      </abbr>
    )
  const book = split.event
  return (
    <abbr
      title={title}
      className={cn(
        "rounded-xs px-0.5 text-[9px] font-bold no-underline sm:px-1 sm:text-[10px]",
        book.side === "bid" ? "bg-up/15 text-up" : "bg-down/15 text-down"
      )}
    >
      {BOOK_EVENT_MARKS[book.kind]}
    </abbr>
  )
}
