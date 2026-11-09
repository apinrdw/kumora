// @vitest-environment happy-dom
import { StockCode, TradeNumber, type RunningTrade } from "@workspace/relay"
import { DateTime } from "effect"
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
  applyViewerMessage(emptyTape(), {
    _tag: "Delta",
    tape: Array.from({ length: count }, (_, i) => trade(from + i)),
    candles: [],
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
