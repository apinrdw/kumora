// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test } from "vitest"

import { HoldingComposition } from "@/components/stocks/holding-composition"
import type { ChartOrigin } from "@/lib/stock-search"
import type { SeriesMonth } from "@/server/holdings/stock-page"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const HELD = {
  ID: 60,
  CP: 20,
  MF: 10,
  IB: 5,
  IS: 5,
  SC: 0,
  PF: 0,
  FD: 0,
  OT: 0,
}
const SERIES: ReadonlyArray<SeriesMonth> = [
  {
    month: "2026-10",
    holdings: { periodEnd: "2026-10-30", local: HELD, foreign: HELD },
  },
]

const container = document.createElement("div")
document.body.append(container)
const root = createRoot(container)
afterEach(() => act(() => root.render(null)))

const render = (origin: ChartOrigin) =>
  act(() =>
    root.render(
      <HoldingComposition
        series={SERIES}
        origin={origin}
        view="table"
        onOrigin={() => {}}
        onView={() => {}}
      />
    )
  )

const legend = (label: string) =>
  [...container.querySelectorAll('[aria-label="Legend"] button')].find(
    (button) => button.textContent === label
  )

test("another chart origin shows every series again", async () => {
  await render("local")
  // A keyboard press hides at once; a click waits out a double-click.
  await act(() => (legend("Individual") as HTMLButtonElement).click())
  expect(legend("Individual")?.getAttribute("aria-pressed")).toBe("false")
  await render("foreign")
  expect(legend("Individual")?.getAttribute("aria-pressed")).toBe("true")
})
