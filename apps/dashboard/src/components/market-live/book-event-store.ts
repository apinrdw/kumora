import {
  BOOK_EVENT_WINDOW_MS,
  BookEventOrder,
  MAX_CODE_BOOK_EVENTS,
  MAX_CODE_ORDER_FLOW_EVENTS,
  MIN_SIDE_FRAMES,
  OrderFlowEventOrder,
  type BookEvent,
  type OrderBook,
  type OrderFlowEvent,
  type RecordedBookEvents,
  type RecordedOrderFlowEvents,
  type StockCode,
  type ViewerDown,
} from "@workspace/relay"
import { Array as Arr, DateTime, Effect } from "effect"

export interface BookEventStore {
  readonly code: StockCode
  // The code's events for the day, oldest first: its newest
  // MAX_CODE_BOOK_EVENTS, as its snapshot and its recorded day's answer hold.
  readonly events: () => ReadonlyArray<BookEvent>
  // The code's order flow events for the day, oldest first: its newest
  // MAX_CODE_ORDER_FLOW_EVENTS, as its snapshot and its recorded day's
  // answer hold.
  readonly orderFlowEvents: () => ReadonlyArray<OrderFlowEvent>
  // False for a recorded day kept before book events were.
  readonly recorded: () => boolean
  // False for a recorded day kept before order flow events were.
  readonly orderFlowRecorded: () => boolean
  // The event picked in the list, book or order flow, by its key
  // (lib/order-flow-events.ts, marketEventKey), whose heatmap mark is
  // ringed.
  readonly picked: () => string | undefined
  readonly pick: (key: string | undefined) => void
  // Whether each side had fewer than MIN_SIDE_FRAMES frames in the window
  // before `now`: the ledger can't read the code. Never before this browser
  // has heard the code's frames for a whole window: it counts only those.
  readonly quiet: (now: number) => boolean
  // The trading-day object's clock at `local` on this one, as its last
  // message's send time read it: the instant events and frames are stamped
  // on.
  readonly now: (local: number) => number
  readonly apply: (message: ViewerDown) => void
  // A recorded day's GET answers.
  readonly load: (answer: RecordedBookEvents) => void
  readonly loadOrderFlow: (answer: RecordedOrderFlowEvents) => void
  readonly subscribe: (listener: () => void) => () => void
}

// The selected code's book and order flow events, outside React: live from
// the viewer socket, or a recorded day's from its GETs. A
// snapshot of this code replaces them and a delta's of this code add to
// them. Its books' side times, kept
// for the window, say whether it is too quiet to read.
export const makeBookEventStore = (code: StockCode) =>
  Effect.sync((): BookEventStore => {
    let events: ReadonlyArray<BookEvent> = []
    let orderFlowEvents: ReadonlyArray<OrderFlowEvent> = []
    let recorded = true
    let orderFlowRecorded = true
    let picked: string | undefined
    // The object's clock less this one's, at its last message.
    let skew = 0
    // When, on the object's clock, this browser's socket started hearing the
    // code: its last snapshot of the code.
    let since: number | undefined
    const sideTimes = { bid: [] as Array<number>, offer: [] as Array<number> }
    const listeners = new Set<() => void>()
    const tell = () => {
      for (const listener of listeners) listener()
    }
    const noteBook = (book: OrderBook) => {
      const times = {
        bid: DateTime.toEpochMillis(book.bidAt ?? book.at),
        offer: DateTime.toEpochMillis(book.offerAt ?? book.at),
      }
      for (const side of ["bid", "offer"] as const) {
        const kept = sideTimes[side]
        if (kept.at(-1) !== times[side]) kept.push(times[side])
        while (
          kept.length > 0 &&
          kept[0]! <= times[side] - BOOK_EVENT_WINDOW_MS
        )
          kept.shift()
      }
    }
    return {
      code,
      events: () => events,
      orderFlowEvents: () => orderFlowEvents,
      recorded: () => recorded,
      orderFlowRecorded: () => orderFlowRecorded,
      picked: () => picked,
      pick: (key) => {
        picked = key
        tell()
      },
      quiet: (now) =>
        since !== undefined &&
        now - since >= BOOK_EVENT_WINDOW_MS &&
        (["bid", "offer"] as const).every(
          (side) =>
            sideTimes[side].filter((t) => t > now - BOOK_EVENT_WINDOW_MS)
              .length < MIN_SIDE_FRAMES
        ),
      now: (local) => local + skew,
      apply: (message) => {
        skew = DateTime.toEpochMillis(message.at) - Date.now()
        if (message._tag === "Snapshot") {
          if (message.selected !== code) return
          since = DateTime.toEpochMillis(message.at)
          if (message.orderBook?._tag === "OrderBook")
            noteBook(message.orderBook)
          events = message.selectedBookEvents ?? []
          orderFlowEvents = message.selectedOrderFlowEvents ?? []
          return tell()
        }
        const book = message.orderBooks?.find((each) => each.code === code)
        if (book !== undefined) noteBook(book)
        const arriving = (message.bookEvents ?? []).filter(
          (event) => event.code === code
        )
        if (arriving.length > 0)
          events = Arr.sort([...events, ...arriving], BookEventOrder).slice(
            -MAX_CODE_BOOK_EVENTS
          )
        const flowing = (message.orderFlowEvents ?? []).filter(
          (event) => event.code === code
        )
        if (flowing.length > 0)
          orderFlowEvents = Arr.sort(
            [...orderFlowEvents, ...flowing],
            OrderFlowEventOrder
          ).slice(-MAX_CODE_ORDER_FLOW_EVENTS)
        if (book !== undefined || arriving.length > 0 || flowing.length > 0)
          tell()
      },
      load: (answer) => {
        events = answer.events
        recorded = answer.recorded
        tell()
      },
      loadOrderFlow: (answer) => {
        orderFlowEvents = answer.events
        orderFlowRecorded = answer.recorded
        tell()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  })
