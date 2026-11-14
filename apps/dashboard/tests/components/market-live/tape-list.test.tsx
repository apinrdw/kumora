// @vitest-environment happy-dom
import {
  BrokerCode,
  StockCode,
  TradeNumber,
  type RunningTrade,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"

import { TapeList } from "@/components/market-live/tape-list"
import { applyViewerMessage, emptyTape } from "@/lib/tape"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const trade = (n: number): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(n)),
  time: DateTime.makeUnsafe("2026-11-09T09:00:01+07:00"),
  code: StockCode.make("BBCA"),
  price: 9_000,
  lots: 1,
  side: "buy",
  board: "RG",
  feeds: ["Ajaib"],
})

// A tape of `count` trades numbered from `from`.
const tapeOf = (from: number, count: number) =>
  Effect.runSync(
    applyViewerMessage(Effect.runSync(emptyTape()), {
      _tag: "Delta",
      tape: Array.from({ length: count }, (_, i) => trade(from + i)),
      candles: [],
    })
  )

// A socket's first snapshot: the tape starts over from the `count` trades
// numbered from `from`.
const snapshotOf = (from: number, count: number): ViewerDown => ({
  _tag: "Snapshot",
  selected: StockCode.make("BBCA"),
  tape: Array.from({ length: count }, (_, i) => trade(from + i)),
  candles: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

const shownNumbers = (container: Element) =>
  [...container.querySelectorAll("tr[data-trade-number]")].map((row) =>
    Number(row.getAttribute("data-trade-number"))
  )

test("a recorded tape scrolled down shows the tape it is given next, not the one it was scrolled on", () => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const render = (tape: ReturnType<typeof tapeOf>, frame: number) =>
    act(() =>
      root.render(
        <TapeList
          tape={tape}
          frame={frame}
          selected={StockCode.make("BBCA")}
          onSelect={() => {}}
        />
      )
    )
  render(tapeOf(1, 60), 1)
  expect(Math.max(...shownNumbers(container))).toBe(60)

  const scroller = container.querySelector("table")!.parentElement!
  act(() => {
    scroller.scrollTop = 600
    scroller.dispatchEvent(new Event("scroll"))
  })
  // The replay cursor moved: the tape at the new cursor replaces it whole.
  render(tapeOf(1001, 60), 2)
  const numbers = shownNumbers(container)
  expect(numbers.length).toBeGreaterThan(0)
  expect(Math.min(...numbers)).toBeGreaterThan(1000)
  expect(container.querySelector("button[type=button].absolute")).toBeNull()
  act(() => root.unmount())
})

test("a recorded tape scrolled past the end of the shorter tape it is given next shows that tape", () => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const render = (tape: ReturnType<typeof tapeOf>, frame: number) =>
    act(() =>
      root.render(
        <TapeList
          tape={tape}
          frame={frame}
          selected={StockCode.make("BBCA")}
          onSelect={() => {}}
        />
      )
    )
  render(tapeOf(1, 200), 1)
  const scroller = container.querySelector("table")!.parentElement!
  act(() => {
    scroller.scrollTop = 3300
    scroller.dispatchEvent(new Event("scroll"))
  })
  // The replay cursor moved earlier: 20 trades, all above the viewport, which
  // the list views from the tape's end (its oldest trade).
  render(tapeOf(1001, 20), 2)
  const numbers = shownNumbers(container)
  expect(numbers.length).toBeGreaterThan(0)
  expect(Math.min(...numbers)).toBe(1001)
  act(() => root.unmount())
})

test("a live tape scrolled down counts the trades a reconnect's snapshot brings as new", () => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const render = (tape: ReturnType<typeof tapeOf>) =>
    act(() =>
      root.render(
        <TapeList
          tape={tape}
          frame={1}
          live
          selected={StockCode.make("BBCA")}
          onSelect={() => {}}
        />
      )
    )
  const tape = tapeOf(1, 300)
  render(tape)
  const scroller = container.querySelector("table")!.parentElement!
  act(() => {
    scroller.scrollTop = 600
    scroller.dispatchEvent(new Event("scroll"))
  })
  // The socket dropped and reconnected: its first snapshot, 50 trades newer
  // than any held among the 200 newest.
  render(Effect.runSync(applyViewerMessage(tape, snapshotOf(151, 200))))
  expect(
    container.querySelector("button[type=button].absolute")?.textContent
  ).toBe("50 new trades ↑")
  act(() => root.unmount())
})

test("an odd lot shows its hundredths: 1 share is 0.01 lots, 25 shares 0.25", () => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const tape = Effect.runSync(
    applyViewerMessage(Effect.runSync(emptyTape()), {
      _tag: "Delta",
      tape: [
        { ...trade(1), lots: 0.01, board: "NG", side: "none" },
        { ...trade(2), lots: 0.25, board: "NG", side: "none" },
        { ...trade(3), lots: 0.5, board: "NG", side: "none" },
        { ...trade(4), lots: 12 },
      ],
      candles: [],
    })
  )
  act(() =>
    root.render(
      <TapeList
        tape={tape}
        frame={1}
        selected={StockCode.make("BBCA")}
        onSelect={() => {}}
      />
    )
  )
  const lotsOf = (n: number) =>
    container
      .querySelector(`tr[data-trade-number="${n}"]`)!
      .querySelectorAll("td")[3]!.textContent
  expect([lotsOf(1), lotsOf(2), lotsOf(3), lotsOf(4)]).toEqual([
    "0.01",
    "0.25",
    "0.5",
    "12",
  ])
  act(() => root.unmount())
})

// Trade 1 bought by a foreign AK from a domestic CD; trade 2 with no codes.
const CODES = new Map([
  [
    TradeNumber.make("1"),
    {
      buyer: BrokerCode.make("AK"),
      buyerType: "F",
      seller: BrokerCode.make("CD"),
      sellerType: "D",
    },
  ],
] as const)

const cellsOf = (container: Element, n: number) =>
  [
    ...container
      .querySelector(`tr[data-trade-number="${n}"]`)!
      .querySelectorAll("td"),
  ].map((cell) => cell.textContent)

const headers = (container: Element) =>
  [...container.querySelectorAll("thead th")].map((cell) => cell.textContent)

test("a trade's Buyer and Seller show each broker code and investor type, after Value", () => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  act(() =>
    root.render(
      <TapeList
        tape={tapeOf(1, 2)}
        frame={1}
        codes={CODES}
        selected={StockCode.make("BBCA")}
        onSelect={() => {}}
      />
    )
  )
  expect(headers(container)).toEqual([
    "Time",
    "Code",
    "Price",
    "Lot",
    "Value",
    "Buyer",
    "Seller",
    "Source",
  ])
  const [, , price, , , buyer, seller] = cellsOf(container, 1)
  expect([price, buyer, seller]).toEqual(["9,000 buy", "AK [F]", "CD [D]"])
  act(() => root.unmount())
})

test("a trade without codes shows blank Buyer and Seller cells", () => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  act(() =>
    root.render(
      <TapeList
        tape={tapeOf(1, 2)}
        frame={1}
        codes={CODES}
        selected={StockCode.make("BBCA")}
        onSelect={() => {}}
      />
    )
  )
  const [, , , , , buyer, seller] = cellsOf(container, 2)
  expect([buyer, seller]).toEqual(["", ""])
  act(() => root.unmount())
})

test("gap and fold rows span every column", () => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  // Trade 1 is the opening match's print, which folds.
  const tape = Effect.runSync(
    applyViewerMessage(Effect.runSync(emptyTape()), {
      _tag: "Delta",
      tape: [
        { ...trade(1), time: DateTime.makeUnsafe("2026-11-09T08:58:00+07:00") },
        trade(2),
      ],
      candles: [],
    })
  )
  act(() =>
    root.render(
      <TapeList
        tape={tape}
        frame={1}
        selected={StockCode.make("BBCA")}
        onSelect={() => {}}
        gaps={[{ from: DateTime.makeUnsafe("2026-11-09T08:30:00+07:00") }]}
      />
    )
  )
  const span = (row: string) =>
    container.querySelector(`tr[${row}] td`)?.getAttribute("colspan")
  expect(container.querySelectorAll("thead th")).toHaveLength(8)
  expect([span("data-fold"), span("data-relay-gap")]).toEqual(["8", "8"])
  act(() => root.unmount())
})
