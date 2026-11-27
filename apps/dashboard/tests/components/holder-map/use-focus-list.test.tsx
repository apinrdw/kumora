// @vitest-environment happy-dom
import { StockCode, WibDate } from "@workspace/relay"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import {
  type FocusListState,
  useFocusList,
  useMapFocusList,
} from "@/components/holder-map/use-focus-list"
import type { FocusList } from "@/lib/holder-map-search"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  list: vi.fn<(request: { data: { day?: string } }) => Promise<unknown>>(),
}))

vi.mock("@/server/stocks/stocks.functions", () => ({
  holderMapSearchListFn: (request: { data: { day?: string } }) =>
    mocks.list(request),
}))

afterEach(() => {
  mocks.list.mockReset()
})

const FRIDAY = WibDate.make("2026-11-20")
const THURSDAY = WibDate.make("2026-11-19")

const FRIDAYS: FocusList = {
  stocks: [{ code: StockCode.make("TRUE"), issuerName: "TRUE" }],
  holders: [],
  custodians: [],
}

test("loads again, not the day before's list, when the day changes and its load fails", async () => {
  mocks.list.mockImplementation(({ data }) =>
    data.day === FRIDAY
      ? Promise.resolve(FRIDAYS)
      : Promise.reject(new Error("offline"))
  )
  const seen: Array<FocusListState> = []
  const Probe = ({ day }: { day: WibDate }) => {
    seen.push(useFocusList("/holder-map", day))
    return null
  }
  const root = createRoot(document.createElement("div"))
  // The load's promise and the runtime's fiber settle.
  const settle = () =>
    act(() => new Promise((settled) => setTimeout(settled, 50)))
  act(() => root.render(<Probe day={FRIDAY} />))
  await settle()
  expect(seen.at(-1)?._tag).toBe("Ready")
  act(() => root.render(<Probe day={THURSDAY} />))
  await settle()
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(seen.at(-1)).toEqual({ _tag: "Loading" })
  act(() => root.unmount())
})

const THURSDAYS: FocusList = {
  stocks: [{ code: StockCode.make("ASRI"), issuerName: "ASRI" }],
  holders: [],
  custodians: [],
}

test("loads the newer day's list when the map with no day asked moves onto it", async () => {
  // The newest day is Thursday's until Friday's is parsed (codex review of
  // apinrdw/kumora#741, round 10).
  let newest = THURSDAYS
  mocks.list.mockImplementation(({ data }) =>
    Promise.resolve(
      data.day === FRIDAY ? FRIDAYS : data.day === THURSDAY ? THURSDAYS : newest
    )
  )
  const seen: Array<FocusListState> = []
  const Probe = ({ day }: { day: WibDate }) => {
    seen.push(useMapFocusList("/holder-map", { day }, undefined))
    return null
  }
  const root = createRoot(document.createElement("div"))
  const settle = () =>
    act(() => new Promise((settled) => setTimeout(settled, 50)))
  act(() => root.render(<Probe day={THURSDAY} />))
  await settle()
  expect(seen.at(-1)).toEqual({ _tag: "Ready", list: THURSDAYS })
  newest = FRIDAYS
  act(() => root.render(<Probe day={FRIDAY} />))
  await settle()
  expect(seen.at(-1)).toEqual({ _tag: "Ready", list: FRIDAYS })
  act(() => root.unmount())
})

test("loads the day asked for when the map refused it", async () => {
  mocks.list.mockImplementation(() => Promise.resolve(FRIDAYS))
  const Probe = () => {
    useMapFocusList("/holder-map", { day: undefined }, THURSDAY)
    return null
  }
  const root = createRoot(document.createElement("div"))
  act(() => root.render(<Probe />))
  await act(() => new Promise((settled) => setTimeout(settled, 50)))
  expect(mocks.list.mock.calls.map(([{ data }]) => data.day)).toEqual([
    THURSDAY,
  ])
  act(() => root.unmount())
})
