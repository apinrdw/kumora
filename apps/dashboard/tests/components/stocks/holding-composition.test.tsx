// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { HoldingComposition } from "@/components/stocks/holding-composition"
import type { ChartView, OriginShown } from "@/lib/stock-search"
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

const render = (
  origin: OriginShown,
  series = SERIES,
  view: ChartView = "table"
) =>
  act(() =>
    root.render(
      <HoldingComposition
        series={series}
        origin={origin}
        view={view}
        onOrigin={() => {}}
        onView={() => {}}
      />
    )
  )

const legend = (label: string) =>
  [...container.querySelectorAll('[aria-label="Legend"] button')].find(
    (button) => button.textContent === label
  )

const pressed = () =>
  [...container.querySelectorAll('[aria-label="Legend"] button')].flatMap(
    (button) =>
      button.getAttribute("aria-pressed") === "true" ? [button.textContent] : []
  )

const allSeries = () =>
  [...container.querySelectorAll('[aria-label="Legend"] button')].map(
    (button) => button.textContent
  )

test.each([{ foreignLegend: false }, { foreignLegend: true }])(
  "switching origin away and back shows every series (Foreign legend used: $foreignLegend)",
  async ({ foreignLegend }) => {
    await render("local")
    // A keyboard press hides at once; a click waits out a double-click.
    await act(() => (legend("Individual") as HTMLButtonElement).click())
    expect(legend("Individual")?.getAttribute("aria-pressed")).toBe("false")
    await render("foreign")
    expect(pressed()).toEqual(allSeries())
    if (foreignLegend)
      await act(() => (legend("Corporate") as HTMLButtonElement).click())
    await render("local")
    expect(pressed()).toEqual(allSeries())
  }
)

// Fires a mouse click, `detail` its click count.
const click = (label: string, detail: number) =>
  act(() => {
    legend(label)?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail })
    )
  })

// A browser's double-click: two clicks `gap` ms apart, then a dblclick.
const doubleClick = async (label: string, gap: number) => {
  await click(label, 1)
  await act(() => vi.advanceTimersByTime(gap))
  await click(label, 2)
  await act(() => {
    legend(label)?.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, detail: 2 })
    )
  })
}

// Fires a keyboard press: a click with no click count.
const press = (label: string) =>
  act(() => (legend(label) as HTMLButtonElement).click())

const hiddenOf = () => allSeries().filter((label) => !pressed().includes(label))

test("clicks on two legend entries in quick succession hide both at once", async () => {
  await render("local")
  await click("Individual", 1)
  await click("Corporate", 1)
  expect(hiddenOf()).toEqual(["Individual", "Corporate"])
})

for (const gap of [0, 300])
  test(`a double-click ${gap} ms apart shows only that entry, and another shows all`, async () => {
    vi.useFakeTimers()
    try {
      await render("local")
      await doubleClick("Individual", gap)
      expect(pressed()).toEqual(["Individual"])
      await doubleClick("Individual", gap)
      expect(pressed()).toEqual(allSeries())
    } finally {
      vi.useRealTimers()
    }
  })

test("a double-click on a hidden entry shows only that one", async () => {
  vi.useFakeTimers()
  try {
    await render("local")
    await click("Corporate", 1)
    await doubleClick("Corporate", 300)
    expect(pressed()).toEqual(["Corporate"])
  } finally {
    vi.useRealTimers()
  }
})

test("two keyboard presses hide an entry and show it again", async () => {
  await render("local")
  await press("Individual")
  expect(hiddenOf()).toEqual(["Individual"])
  await press("Individual")
  expect(pressed()).toEqual(allSeries())
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

// Local holds 40 of 100 in August and 30 of 100 in October; September is a
// gap.
const held = (local: number, foreign: number) => ({
  ...Object.fromEntries(Object.keys(HELD).map((type) => [type, 0])),
  ID: local,
  CP: foreign,
})
const BARS: ReadonlyArray<SeriesMonth> = [
  {
    month: "2026-08",
    holdings: {
      periodEnd: "2026-08-29",
      local: held(40, 0) as typeof HELD,
      foreign: held(0, 60) as typeof HELD,
    },
  },
  { month: "2026-09", holdings: undefined },
  {
    month: "2026-10",
    holdings: {
      periodEnd: "2026-10-30",
      local: held(30, 0) as typeof HELD,
      foreign: held(0, 70) as typeof HELD,
    },
  },
]

const barsChart = () =>
  container.querySelector<SVGElement>('svg[role="img"]') as SVGElement

const announced = () =>
  document.querySelector('[role="status"]')?.getAttribute("aria-label")

const key = (name: string) =>
  act(() => {
    barsChart().dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true })
    )
  })

test("the Bars chart announces the month a keyboard user steps to", async () => {
  await render("all", BARS, "bars")
  await act(() => barsChart().focus())
  await key("End")
  expect(announced()).toBe(
    "Oct 2026\nForeign 70.00%\nLocal 30.00%\nShare of scripless shares."
  )
  await key("ArrowLeft")
  expect(announced()).toBe(
    "Sep 2026: No data, KSEI's report has no row for this month."
  )
})
