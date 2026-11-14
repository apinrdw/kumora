// @vitest-environment happy-dom
import type * as Client from "@workspace/client"
import {
  StockCode,
  WibDate,
  type OrderBook,
  type RecordedHeatmap,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import type { HeatmapStore } from "@/components/market-live/heatmap-store"
import { useHeatmap } from "@/components/market-live/use-heatmap"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  heatmap: vi.fn<() => Effect.Effect<Option.Option<RecordedHeatmap>>>(),
}))

vi.mock("@workspace/client", async (importOriginal) => ({
  ...(await importOriginal<typeof Client>()),
  fetchRecordedHeatmap: () => mocks.heatmap(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  mocks.heatmap.mockReset()
})

const UNTR = StockCode.make("UNTR")
const TODAY = WibDate.make("2026-11-09")
const wib = (time: string) => Date.parse(`2026-11-09T${time}+07:00`)

const book = (at: number, bid: number): OrderBook => ({
  _tag: "OrderBook",
  code: UNTR,
  bids: [{ price: 8_000, lots: bid, orders: 1 }],
  offers: [],
  bidLots: bid,
  offerLots: 0,
  at: DateTime.makeUnsafe(at),
  provenance: "Stockbit",
})

const snapshot = (orderBook: OrderBook): ViewerDown => ({
  _tag: "Snapshot",
  selected: UNTR,
  tape: [],
  candles: [],
  footprints: [],
  orderBook,
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

const answer = (
  through: string,
  slices: ReadonlyArray<readonly [string, number]>
): RecordedHeatmap => ({
  code: UNTR,
  through: DateTime.makeUnsafe(wib(through)),
  slices: slices.map(([at, bid]) => ({
    at: DateTime.makeUnsafe(wib(at)),
    levels: [[8_000, bid, 0]],
  })),
})

// The store's slices as [WIB time, bid lots at 8,000].
const shown = (store: HeatmapStore) =>
  store
    .slices()
    .map((slice) => [
      DateTime.formatIso(DateTime.add(slice.at, { hours: 7 })).slice(11, 19),
      slice.levels[0]?.[1],
    ])

const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))

test("a reconnect's snapshot loads the heatmap again, its slices replacing the ones built across the disconnect", async () => {
  let now = wib("14:20:10")
  vi.spyOn(Date, "now").mockImplementation(() => now)
  mocks.heatmap.mockReturnValue(
    Effect.succeed(Option.some(answer("14:20:10", [["14:20:00", 7]])))
  )
  let store: HeatmapStore | undefined
  function Harness() {
    store = useHeatmap(UNTR, undefined, TODAY)
    return null
  }
  const root = createRoot(document.createElement("div"))
  await act(() => root.render(<Harness />))
  act(() => store!.apply(snapshot(book(now, 50))))
  await settle()
  expect(shown(store!)).toEqual([
    ["14:20:00", 7],
    ["14:20:10", 50],
  ])

  // The socket drops; the page keeps ticking on the last book it heard.
  now = wib("14:20:40")
  act(() => store!.tick())
  expect(shown(store!).slice(1)).toEqual([
    ["14:20:10", 50],
    ["14:20:20", 50],
    ["14:20:30", 50],
    ["14:20:40", 50],
  ])

  // The object recorded a different book meanwhile.
  mocks.heatmap.mockReturnValue(
    Effect.succeed(
      Option.some(
        answer("14:20:40", [
          ["14:20:00", 7],
          ["14:20:10", 30],
          ["14:20:20", 3],
          ["14:20:30", 3],
        ])
      )
    )
  )
  act(() => store!.apply(snapshot(book(now, 90))))
  await settle()
  expect(shown(store!)).toEqual([
    ["14:20:00", 7],
    ["14:20:10", 30],
    ["14:20:20", 3],
    ["14:20:30", 3],
    ["14:20:40", 90],
  ])
  await act(() => root.unmount())
})
