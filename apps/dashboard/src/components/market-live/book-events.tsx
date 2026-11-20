// The selected code's book events on Market Live (spec apinrdw/kumora#517,
// "The Book readout" and "Book events"): the readout's list, and the recent
// events the ladder marks. Live from the viewer socket, or a recorded day's
// from its GET, dimmed past the cursor.
import { clientRuntime, fetchRecordedBookEvents } from "@workspace/client"
import {
  INDEX_CODES,
  READING_PHASES,
  type BookEvent,
  type BookEventSide,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { DateTime, Effect, Fiber, Option } from "effect"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react"

import {
  BOOK_EVENTS_FROM,
  BOOK_EVENT_MARKS,
  BOOK_EVENT_NAMES,
  bookEventDetail,
  bookEventKey,
} from "@/lib/book-events"
import { dayLabel, tapeTime } from "@/lib/format"
import {
  MarketEventOrder,
  marketEventDetail,
  marketEventKey,
  type MarketEvent,
} from "@/lib/order-flow-events"

import { makeBookEventStore, type BookEventStore } from "./book-event-store"
import { EventName } from "./event-mark"
import { useMarketPhase } from "./market-conditions"
import type { ReplayCursor } from "./replay-cursor"
import { loadedOrSignIn } from "./sign-in-again"

// Decision: the ladder marks a level's book events for 2 minutes. See spec
// apinrdw/kumora#517, "Book events".
const MARK_MS = 120_000

// How often the live list and marks look at the clock again.
const TICK_MS = 1_000

// The selected code's book event store for the recorded `day`, or live.
// A recorded day's is loaded once by its GET; live, the page feeds it the
// socket's messages. An index has no book, so nothing is asked.
export function useBookEvents(code: StockCode, day: WibDate | undefined) {
  const store = useMemo(() => Effect.runSync(makeBookEventStore(code)), [code])
  useEffect(() => {
    if (day === undefined || INDEX_CODES.includes(code)) return
    const fiber = clientRuntime.runFork(
      loadedOrSignIn(
        fetchRecordedBookEvents(day, code).pipe(
          Effect.tap((answer) =>
            Effect.sync(() => {
              if (Option.isSome(answer)) store.load(answer.value)
            })
          )
        ),
        "Book events"
      )
    )
    return () => void clientRuntime.runFork(Fiber.interrupt(fiber))
  }, [store, code, day])
  return store
}

const noSubscribe = () => () => {}

// The object's clock live, ticking each TICK_MS; the cursor on a recorded
// day.
function useNow(store: BookEventStore, cursor: ReplayCursor | undefined) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (cursor !== undefined) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [cursor])
  const at = useSyncExternalStore(
    cursor?.subscribe ?? noSubscribe,
    () => cursor?.state().at,
    () => cursor?.state().at
  )
  return at ?? store.now(now)
}

const useEvents = (store: BookEventStore) =>
  useSyncExternalStore(store.subscribe, store.events, store.events)

// The code's book and order flow events together, oldest first.
const useMarketEvents = (store: BookEventStore) => {
  const events = useEvents(store)
  const flowing = useSyncExternalStore(
    store.subscribe,
    store.orderFlowEvents,
    store.orderFlowEvents
  )
  return useMemo(
    () => [...events, ...flowing].sort((a, b) => MarketEventOrder(a, b)),
    [events, flowing]
  )
}

/**
 * The events of the last 2 minutes up to now, or up to the cursor on a
 * recorded day, for the ladder's marks.
 */
export function useRecentBookEvents(
  store: BookEventStore,
  cursor: ReplayCursor | undefined
) {
  const events = useEvents(store)
  const now = useNow(store, cursor)
  return events.filter((event) => {
    const at = DateTime.toEpochMillis(event.at)
    return at <= now && now - at < MARK_MS
  })
}

/** The marks of a ladder level's recent events. */
export function LadderMarks({
  events,
  side,
  price,
}: {
  events: ReadonlyArray<BookEvent>
  side: BookEventSide
  price: number
}) {
  const here = events.filter(
    (event) => event.side === side && event.price === price
  )
  return here.map((event) => (
    <abbr
      key={Effect.runSync(bookEventKey(event))}
      title={`${BOOK_EVENT_NAMES[event.kind]}: ${Effect.runSync(bookEventDetail(event))}`}
      className={cn(
        "mx-0.5 rounded-xs px-0.5 text-[9px] font-bold no-underline",
        side === "bid" ? "text-up bg-up/15" : "text-down bg-down/15"
      )}
    >
      {BOOK_EVENT_MARKS[event.kind]}
    </abbr>
  ))
}

/** The one-line legend under a ladder with marks. */
export function LadderMarksLegend() {
  return (
    <p className="text-[11px] text-muted-foreground">
      Marks on a level: AB absorbed · EA eaten · RL reloaded · W+ wall appeared
      · W− pulled · W→ moved (last 2 minutes)
    </p>
  )
}

function Note({ children }: { children: string }) {
  return <p className="py-2 text-[12px] text-muted-foreground">{children}</p>
}

function EventRow({
  event,
  eventKey,
  after,
  picked,
  onPick,
}: {
  event: MarketEvent
  eventKey: string
  after: boolean
  picked: boolean
  onPick: () => void
}) {
  return (
    <li data-event-key={eventKey}>
      <button
        type="button"
        aria-pressed={picked}
        onClick={onPick}
        className={cn(
          "grid w-full grid-cols-[58px_auto_1fr] items-baseline gap-1.5 border-t border-border py-1 text-left text-[12px]",
          after && "opacity-30",
          picked && "bg-accent/40"
        )}
      >
        <span className="text-muted-foreground tabular-nums">
          {Effect.runSync(tapeTime(DateTime.toEpochMillis(event.at)))}
        </span>
        <EventName event={event} />
        <span className="text-muted-foreground">
          {Effect.runSync(marketEventDetail(event))}
        </span>
      </button>
    </li>
  )
}

// What the list says instead of its events: none when it lists them. A
// quiet code with events today lists them: the note would read as if they
// were wrong.
const listNote = (state: {
  readonly recorded: boolean
  readonly live: boolean
  readonly quiet: boolean
  readonly empty: boolean
}) =>
  Effect.gen(function* () {
    if (!state.recorded)
      return `Book events not recorded before ${yield* dayLabel(BOOK_EVENTS_FROM)}.`
    if (!state.empty) return undefined
    if (state.quiet)
      return "Too quiet to read: fewer than 2 book updates a side in the last 30 s."
    return state.live ? "No book events yet today." : "No book events this day."
  })

// Picks the event keyed `landOn` once the store holds it, and scrolls the
// list to it: a link from the scanner's feed lands there. It lands once per
// store and key, so Back to the link, which brings a fresh store, lands again.
function useLandOn(
  store: BookEventStore,
  events: ReadonlyArray<MarketEvent>,
  landOn: string | undefined,
  list: RefObject<HTMLOListElement | null>
) {
  const landed = useRef<
    { readonly store: BookEventStore; readonly key: string } | undefined
  >(undefined)
  useEffect(() => {
    if (landOn === undefined) {
      landed.current = undefined
      return
    }
    if (landed.current?.store === store && landed.current.key === landOn) return
    const found = events.some(
      (event) => Effect.runSync(marketEventKey(event)) === landOn
    )
    if (!found) return
    landed.current = { store, key: landOn }
    store.pick(landOn)
    list.current
      ?.querySelector(`[data-event-key="${CSS.escape(landOn)}"]`)
      ?.scrollIntoView({ block: "center" })
  }, [store, events, landOn, list])
}

/**
 * The readout's Events part: the code's book and order flow events,
 * mixed newest first. Picking
 * one rings its heatmap mark; on a recorded day those after the cursor are
 * dimmed. A link can land on one, `landOn` by its key.
 */
export function BookEventList({
  store,
  cursor,
  landOn,
}: {
  store: BookEventStore
  cursor: ReplayCursor | undefined
  landOn?: string | undefined
}) {
  const events = useMarketEvents(store)
  const list = useRef<HTMLOListElement>(null)
  useLandOn(store, events, landOn, list)
  const picked = useSyncExternalStore(
    store.subscribe,
    store.picked,
    store.picked
  )
  const recorded = useSyncExternalStore(
    store.subscribe,
    store.recorded,
    store.recorded
  )
  const now = useNow(store, cursor)
  const phase = useMarketPhase()
  const note = Effect.runSync(
    listNote({
      recorded,
      live: cursor === undefined,
      // Outside Sessions 1 and 2 the readout's strip says readings are
      // paused: no code is read then, quiet or not.
      quiet:
        cursor === undefined &&
        phase !== undefined &&
        READING_PHASES.has(phase) &&
        store.quiet(now),
      empty: events.length === 0,
    })
  )
  return (
    <section
      aria-label="Events"
      className="flex min-w-0 flex-col gap-1 lg:col-span-2 2xl:col-span-1"
    >
      <h3 className="text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
        Events
      </h3>
      {note !== undefined && <Note>{note}</Note>}
      {recorded && events.length > 0 && (
        <ol ref={list} className="max-h-[230px] overflow-auto">
          {[...events].reverse().map((event) => {
            const key = Effect.runSync(marketEventKey(event))
            return (
              <EventRow
                key={key}
                eventKey={key}
                event={event}
                after={
                  cursor !== undefined && DateTime.toEpochMillis(event.at) > now
                }
                picked={picked === key}
                onPick={() => store.pick(picked === key ? undefined : key)}
              />
            )
          })}
        </ol>
      )}
      {cursor !== undefined && events.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Recorded day: events after the cursor are dimmed.
        </p>
      )}
    </section>
  )
}
