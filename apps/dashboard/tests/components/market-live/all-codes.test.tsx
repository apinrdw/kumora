// @vitest-environment happy-dom
import {
  STANDOUTS_PER_LEVEL,
  StockCode,
  TradeNumber,
  type StandoutLevel,
  type StandoutSweep,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test } from "vitest"

import { useAllCodes } from "@/components/market-live/all-codes"
import type { StandoutStore } from "@/components/market-live/standout-store"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(() => window.localStorage.clear())

// A standout sweep of UNTR at `level`, its first trade `firstTrade`, that
// many seconds into the day: a later trade is a newer row.
const standout = (firstTrade: number, level: StandoutLevel): StandoutSweep => ({
  code: StockCode.make("UNTR"),
  level,
  sweep: {
    side: "buy",
    firstTrade: TradeNumber.make(String(firstTrade)),
    time: DateTime.makeUnsafe(
      Date.parse("2026-11-09T09:00:00+07:00") + firstTrade * 1000
    ),
    first: 1_000,
    last: 1_000,
    lots: 100,
    value: 10_000_000,
    trades: 3,
  },
})

const snapshotOf = (
  standoutSweeps: ReadonlyArray<StandoutSweep>
): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe("2026-11-09T02:30:00Z"),
  selected: StockCode.make("UNTR"),
  tape: [],
  candles: [],
  footprints: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
  standoutSweeps,
})

// The All codes tab of a live page, fed through its store, and the rows it
// lists at the level picked.
const mount = () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let store: StandoutStore | undefined
  function Page() {
    const allCodes = useAllCodes({
      day: undefined,
      index: false,
      onSelect: () => {},
    })
    store = allCodes.store
    return allCodes.tab
  }
  act(() => root.render(<Page />))
  return {
    apply: (message: ViewerDown) => act(() => store!.apply(message)),
    pick: (level: StandoutLevel) =>
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
          .find((radio) => radio.textContent === `${level}%`)!
          .click()
      ),
    listed: () =>
      [...host.querySelectorAll("ol li button")].map((row) =>
        row.getAttribute("title")!
      ),
    shown: () => host.querySelector('[aria-label="Rows shown"]')!.textContent,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

test(
  "a level lists its newest 500 rows, though the page keeps an older one for 1%",
  { timeout: 10_000 },
  () => {
    const page = mount()
    page.apply(
      snapshotOf([
        ...Array.from({ length: STANDOUTS_PER_LEVEL }, (_, index) =>
          standout(STANDOUTS_PER_LEVEL + 1 - index, 10)
        ),
        standout(1, 1),
      ])
    )
    page.pick(10)
    expect(page.listed()).toHaveLength(STANDOUTS_PER_LEVEL)
    expect(page.listed()).not.toContain("UNTR · top 1% · 3 trades")
    expect(page.shown()).toBe("showing 500")
    page.pick(1)
    expect(page.listed()).toEqual(["UNTR · top 1% · 3 trades"])
    page.unmount()
  }
)

test(
  "with mixed levels, each level lists its newest 500 rows",
  { timeout: 10_000 },
  () => {
    const page = mount()
    page.apply(
      snapshotOf(
        Array.from({ length: 3 * STANDOUTS_PER_LEVEL }, (_, index) =>
          standout(
            3 * STANDOUTS_PER_LEVEL - index,
            ([1, 5, 10] as const)[index % 3]!
          )
        )
      )
    )
    page.pick(10)
    expect(page.listed()).toHaveLength(STANDOUTS_PER_LEVEL)
    page.pick(5)
    expect(page.listed()).toHaveLength(STANDOUTS_PER_LEVEL)
    page.pick(1)
    expect(page.listed()).toHaveLength(STANDOUTS_PER_LEVEL)
    page.unmount()
  }
)
