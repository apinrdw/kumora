// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test } from "vitest"

import {
  HolderSize,
  type HolderSizeProps,
} from "@/components/stocks/holder-size"
import { KSEI_TYPES, type KseiType } from "@/domain/holdings"
import type { Holding } from "@/lib/holder-size"
import type {
  Bands,
  HolderSizeMonth,
  TypeBands,
} from "@/server/holdings/stock-page"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const bands = (held: Partial<Record<KseiType, Bands>>): TypeBands =>
  Object.fromEntries(
    KSEI_TYPES.map((type) => [type, held[type] ?? { under5: 0, atLeast5: 0 }])
  ) as TypeBands

// 1,000 shares outstanding, 500 scripless: CP's ≥5% holder 200, ID's <5%
// holders 300, all local.
const holding = (atLeast5: number, under5: number): Holding => ({
  sharesOutstanding: 1000,
  totalScripless: atLeast5 + under5,
  combined: bands({ CP: { under5: 0, atLeast5 }, ID: { under5, atLeast5: 0 } }),
  local: bands({ CP: { under5: 0, atLeast5 }, ID: { under5, atLeast5: 0 } }),
  foreign: bands({}),
})

const unsplit = (held: Holding): Holding => ({
  ...held,
  local: undefined,
  foreign: undefined,
})

const month = (
  dataDate: string,
  held: Holding | undefined
): HolderSizeMonth => ({
  dataDate,
  split: held?.local !== undefined,
  holding: held,
})

const container = document.createElement("div")
document.body.append(container)
const root = createRoot(container)
afterEach(() => act(() => root.render(null)))

const render = (props: Partial<HolderSizeProps>) =>
  act(() =>
    root.render(
      <HolderSize
        code="BBCA"
        months={[]}
        month={undefined}
        origin="all"
        denominator="outstanding"
        view="bars"
        onMonth={() => {}}
        onOrigin={() => {}}
        onDenominator={() => {}}
        onView={() => {}}
        {...props}
      />
    )
  )

const text = () => container.textContent ?? ""

const columns = () =>
  [
    ...container.querySelectorAll('[aria-label="Holder size by month"] button'),
  ].map((column) => column.getAttribute("aria-label"))

const atLeast5Rows = () =>
  [
    ...container.querySelectorAll(
      'table[aria-label="≥5% holders by month"] tr'
    ),
  ].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent)
  )

describe("the Table view", () => {
  const MONTHS = [
    month("2025-12-30", unsplit(holding(200, 300))),
    month("2026-01-30", undefined),
    month("2026-02-27", holding(250, 250)),
  ]

  test("switches from Bars", async () => {
    const picked: Array<string> = []
    await render({ months: MONTHS, onView: (view) => picked.push(view) })
    const table = [
      ...container.querySelectorAll('[aria-label="View"] button'),
    ].find((button) => button.textContent === "Table") as HTMLButtonElement
    await act(() => table.click())
    expect(picked).toEqual(["table"])
  })

  test("stacks each month's ≥5%, <5% and scrip of shares outstanding", async () => {
    await render({ months: MONTHS, view: "table" })
    expect(columns()).toEqual([
      "Dec 2025: ≥5% holders 20.00%, <5% holders 30.00%, Scrip 50.00%",
      "Jan 2026: No data",
      "Feb 2026: ≥5% holders 25.00%, <5% holders 25.00%, Scrip 50.00%",
    ])
    expect(container.querySelector('[aria-label="Month"]')).toBeNull()
  })

  test("marks unsplit months n/a under Local, of local scripless", async () => {
    await render({ months: MONTHS, view: "table", origin: "local" })
    expect(columns()).toEqual([
      "Dec 2025: n/a, not split by origin",
      "Jan 2026: No data",
      "Feb 2026: ≥5% holders 50.00%, <5% holders 50.00%",
    ])
    expect(atLeast5Rows()).toEqual([
      ["≥5% held by", "Dec 25", "Jan 26", "Feb 26"],
      ["Corporate", "n/a", "–", "50.00%"],
    ])
  })

  test("lists each type holding ≥5% month by month", async () => {
    await render({ months: MONTHS, view: "table" })
    expect(atLeast5Rows()).toEqual([
      ["≥5% held by", "Dec 25", "Jan 26", "Feb 26"],
      ["Corporate", "20.00%", "–", "25.00%"],
    ])
  })

  test("says when no type holds ≥5% in any month", async () => {
    await render({
      months: [month("2026-02-27", holding(0, 500))],
      view: "table",
    })
    expect(atLeast5Rows()).toEqual([])
    expect(text()).toContain("BBCA has no ≥5% holders in any month.")
  })
})

const barPart = (label: string) =>
  [...container.querySelectorAll('[aria-label="Holder size bar"] dl > div')]
    .find((part) => part.querySelector("dt")?.textContent === label)
    ?.querySelector("dd")?.textContent

describe("the Bars view", () => {
  test("says the stock's first month has no change", async () => {
    await render({
      months: [
        month("2026-03-31", undefined),
        month("2026-04-30", holding(200, 300)),
      ],
    })
    expect(text()).toContain("First month in the report.")
    expect(barPart("≥5% holders")).toBe("20.00% ")
  })

  test("says a month before without the stock shows no change", async () => {
    await render({
      months: [
        month("2026-03-31", holding(200, 300)),
        month("2026-04-30", undefined),
        month("2026-05-29", holding(200, 300)),
      ],
    })
    expect(text()).toContain(
      "BBCA isn't in Apr 2026's report, so no change is shown."
    )
  })

  test("says an unsplit month before has no local change", async () => {
    await render({
      months: [
        month("2025-12-30", unsplit(holding(200, 300))),
        month("2026-01-30", holding(200, 300)),
      ],
      origin: "local",
    })
    expect(text()).toContain(
      "Dec 2025 has no local/foreign split, so no change is shown."
    )
  })

  test("marks each part's rise, fall and no change against the month before", async () => {
    await render({
      months: [
        month("2026-09-30", holding(200, 300)),
        month("2026-10-30", holding(250, 250)),
      ],
    })
    expect(text()).toContain("Changes are from Sep 2026.")
    expect(barPart("≥5% holders")).toBe("25.00% ▲ 5.00 pts")
    expect(barPart("<5% holders")).toBe("25.00% ▼ 5.00 pts")
    expect(barPart("Scrip")).toBe("50.00% 0.00 pts")
  })
})
