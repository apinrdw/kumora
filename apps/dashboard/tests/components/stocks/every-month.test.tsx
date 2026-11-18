// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test } from "vitest"

import { EveryMonth } from "@/components/stocks/every-month"
import type {
  MajorHolder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Row = MajorHolder["rows"][number]

const row = (name: string, total: number, hundredths: number): Row => ({
  name,
  classification: "corporate",
  type: "CP",
  origin: "local",
  domicile: "INDONESIA",
  controller: undefined,
  total,
  percentageHundredths: hundredths,
})

const holder = (key: string, rows: ReadonlyArray<Row>): MajorHolder => {
  const total = rows.reduce((sum, each) => sum + each.total, 0)
  return {
    key,
    scripless: total,
    scrip: 0,
    total,
    percentageHundredths: rows.reduce(
      (sum, each) => sum + each.percentageHundredths,
      0
    ),
    rows,
  }
}

const month = (
  dataDate: string,
  holders: ReadonlyArray<MajorHolder>
): MajorHoldersMonth => ({ dataDate, holders })

// Jul has no rows for the stock. Aug: Adaro 41%, Gamma 2%, Delta 1.5%.
// Sep: Adaro up, Gamma off, Delta down, Paraga new on two rows. Oct: Adaro
// the same, Gamma back, Delta off, Paraga up.
const MONTHS = [
  month("2026-07-31", []),
  month("2026-08-31", [
    holder("ADARO", [row("ADARO STRATEGIC INVESTMENTS", 3_200, 4100)]),
    holder("GAMMA", [row("GAMMA CAPITAL", 200, 200)]),
    holder("DELTA", [row("DELTA FUND", 150, 150)]),
  ]),
  month("2026-09-30", [
    holder("DELTA", [row("DELTA FUND", 120, 120)]),
    holder("ADARO", [row("ADARO STRATEGIC INVESTMENTS", 3_210, 4110)]),
    holder("PARAGA", [
      row("PARAGA ARTAMIDA, PT", 100, 130),
      row("PT PARAGA ARTAMIDA", 300, 390),
    ]),
  ]),
  month("2026-10-30", [
    holder("ADARO", [row("ADARO STRATEGIC INVESTMENTS", 3_210, 4110)]),
    holder("PARAGA", [row("PT PARAGA ARTAMIDA", 450, 600)]),
    holder("GAMMA", [row("GAMMA CAPITAL", 250, 250)]),
  ]),
]

const container = document.createElement("div")
document.body.append(container)
const root = createRoot(container)
afterEach(() => act(() => root.render(null)))

const render = (selected: string) =>
  act(() => root.render(<EveryMonth months={MONTHS} selected={selected} />))

const grid = () => container.querySelector('table[aria-label="Every month"]')

const header = () =>
  [...(grid()?.querySelectorAll("thead th") ?? [])].map((th) => th.textContent)

const rows = () =>
  [...(grid()?.querySelectorAll("tbody tr") ?? [])].map((tr) => [
    tr.querySelector("th")?.textContent,
    ...[...tr.querySelectorAll("td")].map((cell) => cell.textContent),
  ])

describe("Every month", () => {
  test("has a row per holder of any month and a column per month, each cell its summed %", async () => {
    await render("2026-10-30")
    expect(container.querySelector("h3")?.textContent).toBe("Every month")
    expect(header()).toEqual(["Holder", "Jul 26", "Aug 26", "Sep 26", "Oct 26"])
    expect(rows()).toEqual([
      ["ADARO STRATEGIC INVESTMENTS", "·", "41.00", "41.10▲", "41.10"],
      ["PT PARAGA ARTAMIDA", "·", "·", "5.20•", "6.00▲"],
      ["GAMMA CAPITAL", "·", "2.00", "·", "2.50•"],
      ["DELTA FUND", "·", "1.50", "1.20▼", "·"],
    ])
  })
  test("outlines the selected month and sorts by it, holders not listed in it last and greyed", async () => {
    await render("2026-09-30")
    expect(
      grid()?.querySelector('thead th[aria-current="true"]')?.textContent
    ).toBe("Sep 26")
    expect(rows().map(([name, ...cells]) => [name, cells[2]])).toEqual([
      ["ADARO STRATEGIC INVESTMENTS", "41.10▲"],
      ["PT PARAGA ARTAMIDA", "5.20•"],
      ["DELTA FUND", "1.20▼"],
      ["GAMMA CAPITAL", "·"],
    ])
    const unlisted = [
      ...(grid()?.querySelectorAll("tbody tr[data-unlisted]") ?? []),
    ].map((tr) => tr.querySelector("th")?.textContent)
    expect(unlisted).toEqual(["GAMMA CAPITAL"])
    // Only the Sep column is outlined, one cell per row.
    const outlined = [...(grid()?.querySelectorAll("tbody tr") ?? [])].map(
      (tr) =>
        [...tr.querySelectorAll("td")].findIndex((cell) =>
          cell.hasAttribute("data-selected")
        )
    )
    expect(outlined).toEqual([2, 2, 2, 2])
  })
})
