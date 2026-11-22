// @vitest-environment happy-dom
// The radar's feed mixes order flow rows with book event rows, newest
// first, and a row opens Market Live at its event (spec apinrdw/kumora#605,
// "Order flow events: on the page").
import { StockCode, type ViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test } from "vitest"

import { EventFeed } from "@/components/order-book-radar/event-feed"
import { makeRadarEventsStore } from "@/components/order-book-radar/radar-events-store"
import type { MarketEvent } from "@/lib/order-flow-events"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const BBCA = StockCode.make("BBCA")
// 09:45:00 WIB.
const T0 = Date.parse("2026-11-19T02:45:00Z")

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ""
})

test("an order flow row sits among book event rows and opens its event", () => {
  const store = Effect.runSync(makeRadarEventsStore)
  const message: ViewerDown = {
    _tag: "Delta",
    at: DateTime.makeUnsafe(T0 + 70_000),
    tape: [],
    candles: [],
    bookEvents: [
      {
        kind: "eaten",
        code: BBCA,
        at: DateTime.makeUnsafe(T0 + 30_000),
        side: "offer",
        price: 1250,
        lots: 500,
        orders: 3,
        share: 0.9,
      },
    ],
    orderFlowEvents: [
      {
        kind: "exhaustion",
        code: BBCA,
        at: DateTime.makeUnsafe(T0),
        side: "buy",
        price: 1250,
        lots: 900,
        peakLots: 2400,
        ticks: 1,
        widestTicks: 5,
      },
    ],
  }
  store.apply(message)
  const opened: Array<MarketEvent> = []
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <EventFeed
        store={store}
        codes={new Set([BBCA])}
        onOpen={(event) => opened.push(event)}
      />
    )
  )
  const rows = [...host.querySelectorAll("li button")]
  expect(rows.map((row) => row.textContent)).toEqual([
    "09:45:30BBCAEaten1,250 gone, trades explain 90%",
    "09:45:00BBCA▲EBuying exhaustion at the day's highbuy-aggressor lots 2,400 → 900 a minute · range 5 → 1 ticks",
  ])
  act(() => (rows[1] as HTMLElement).click())
  expect(opened.map((event) => event.kind)).toEqual(["exhaustion"])
})
