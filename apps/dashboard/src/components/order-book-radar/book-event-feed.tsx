// The scanner's Book events feed (spec apinrdw/kumora#517, "Book events"):
// the scanner's codes' events, newest first, live. Each opens Market Live
// at the event.
import type { BookEvent, StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { DateTime, Effect } from "effect"
import { useMemo, useSyncExternalStore } from "react"

import {
  BOOK_EVENT_NAMES,
  bookEventDetail,
  bookEventKey,
} from "@/lib/book-events"
import { tapeTime } from "@/lib/format"

import type { RadarEventsStore } from "./radar-events-store"

// Decision: the feed lists the newest 60 of the scanner's codes' events, as
// the prototype did. See spec apinrdw/kumora#517, "The scanner".
const FEED_EVENTS = 60

function FeedItem({
  event,
  onOpen,
}: {
  event: BookEvent
  onOpen: (event: BookEvent) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(event)}
        className="hover:bg-elevated grid w-full grid-cols-[58px_48px_1fr] items-baseline gap-x-1.5 gap-y-0.5 border-b border-border px-2.5 py-1.5 text-left text-[12px]"
      >
        <span className="text-muted-foreground tabular-nums">
          {Effect.runSync(tapeTime(DateTime.toEpochMillis(event.at)))}
        </span>
        <span className="font-bold tracking-[0.02em]">{event.code}</span>
        <span>
          <span
            className={cn(
              "rounded-xs px-1.5 text-[10px] font-bold whitespace-nowrap",
              event.side === "bid" ? "bg-up/15 text-up" : "bg-down/15 text-down"
            )}
          >
            {BOOK_EVENT_NAMES[event.kind]}
          </span>
        </span>
        <span className="col-start-3 text-muted-foreground">
          {Effect.runSync(bookEventDetail(event))}
        </span>
      </button>
    </li>
  )
}

/**
 * The feed beside the halves from 1,100 px, under them below: `codes`'
 * events from the store, newest first.
 */
export function BookEventFeed({
  store,
  codes,
  onOpen,
}: {
  store: RadarEventsStore
  codes: ReadonlySet<StockCode>
  onOpen: (event: BookEvent) => void
}) {
  const events = useSyncExternalStore(
    store.subscribe,
    store.events,
    store.events
  )
  const shown = useMemo(
    () => events.filter((event) => codes.has(event.code)).slice(0, FEED_EVENTS),
    [events, codes]
  )
  return (
    <section
      aria-label="Book events"
      className="bg-surface max-h-[50vh] min-w-0 overflow-auto rounded-md border border-border min-[1100px]:sticky min-[1100px]:top-2 min-[1100px]:max-h-[74vh]"
    >
      <h2 className="bg-surface sticky top-0 flex justify-between border-b border-border px-2.5 py-2 text-[13px] font-semibold">
        <span>Book events</span>
        <span className="font-normal text-muted-foreground">scanner codes</span>
      </h2>
      {shown.length === 0 ? (
        <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
          Waiting for book events…
        </p>
      ) : (
        <ol aria-label="Book events, newest first">
          {shown.map((event) => (
            <FeedItem
              key={Effect.runSync(bookEventKey(event))}
              event={event}
              onOpen={onOpen}
            />
          ))}
        </ol>
      )}
    </section>
  )
}
