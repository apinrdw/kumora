// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { HoldingComposition } from "@/components/stocks/holding-composition"
import type { OriginShown } from "@/lib/stock-search"
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

const render = (origin: OriginShown, series = SERIES) =>
  act(() =>
    root.render(
      <HoldingComposition
        series={series}
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

test("clicks on two legend entries in quick succession hide both", async () => {
  vi.useFakeTimers()
  try {
    await render("local")
    // A mouse click, which waits out a double-click.
    const click = (label: string) =>
      act(() => {
        legend(label)?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, detail: 1 })
        )
      })
    await click("Individual")
    await click("Corporate")
    await act(() => vi.advanceTimersByTime(1_000))
    expect(legend("Individual")?.getAttribute("aria-pressed")).toBe("false")
    expect(legend("Corporate")?.getAttribute("aria-pressed")).toBe("false")
  } finally {
    vi.useRealTimers()
  }
})

test("the origin summary is unavailable when the newest month holds no shares", async () => {
  const none = Object.fromEntries(Object.keys(HELD).map((type) => [type, 0]))
  await render("all", [
    {
      month: "2026-10",
      holdings: {
        periodEnd: "2026-10-30",
        local: none as typeof HELD,
        foreign: none as typeof HELD,
      },
    },
  ])
  expect(container.querySelector('[aria-label="Foreign share"]')).toBeNull()
  expect(container.textContent).toContain(
    "Unavailable: KSEI lists no scripless shares for Oct 2026."
  )
})
