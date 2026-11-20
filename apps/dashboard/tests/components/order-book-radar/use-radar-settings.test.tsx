// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { DEFAULT_SETTINGS, type RadarSettings } from "@/lib/order-book-radar"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const KEY = "kumora:order-book-radar:settings"

afterEach(() => {
  window.localStorage.clear()
  document.body.innerHTML = ""
})

// The settings a page loaded with `stored` in the browser shows.
const read = async (stored: object) => {
  window.localStorage.setItem(KEY, JSON.stringify(stored))
  vi.resetModules()
  const { useRadarSettings } =
    await import("@/components/order-book-radar/use-radar-settings")
  const seen: { settings?: RadarSettings } = {}
  function Probe() {
    seen.settings = useRadarSettings().settings
    return null
  }
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  act(() => root.render(<Probe />))
  act(() => root.unmount())
  return seen.settings
}

test.each([
  ["bidDepth", "imbalance"],
  ["offerDepth", "imbalance"],
  ["bidNearDepth", "imbalance"],
  ["offerNearDepth", "imbalance"],
  ["emptyTicks", "imbalance"],
  ["spread", "imbalance"],
  ["lotsPerOrder", "lotsPerOrder"],
])("a Rank by stored as %s reads as %s", async (stored, shown) => {
  expect(
    await read({ ...DEFAULT_SETTINGS, rankBy: stored, direction: "low" }),
    "the browser's other settings are kept"
  ).toEqual({ ...DEFAULT_SETTINGS, rankBy: shown, direction: "low" })
})
