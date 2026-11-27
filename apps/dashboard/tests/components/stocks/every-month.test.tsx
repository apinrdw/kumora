// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, test } from "vitest"

import { EveryMonth } from "@/components/stocks/every-month"
import type {
  Above1Holder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Row = Above1Holder["rows"][number]

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

const holder = (key: string, rows: ReadonlyArray<Row>): Above1Holder => {
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
  holders: ReadonlyArray<Above1Holder>
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
  act<void>(() =>
    root.render(<EveryMonth months={MONTHS} selected={selected} />)
  )

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
      ["PT PARAGA ARTAMIDA", "·", "·", "5.20", "6.00▲"],
      ["GAMMA CAPITAL", "·", "2.00", "·", "2.50•"],
      ["DELTA FUND", "·", "1.50", "1.20▼", "·"],
    ])
  })
  test("marks a holder back on the list with a small dot, not one listed for the first time", async () => {
    await render("2026-10-30")
    const marks = [...(grid()?.querySelectorAll("tbody td span") ?? [])].map(
      (mark) => [mark.textContent, mark.getAttribute("title")]
    )
    expect(marks).toContainEqual(["•", "New, back after a month not listed"])
    expect(
      container.querySelector(".text-muted-foreground")?.textContent
    ).toContain(
      "A dot is a month the holder was not listed: sold out or fell below 1%."
    )
  })
  test("server-renders as many rows as fit 6,000 cells, fewer of more months, and every row once hydrated", async () => {
    // 100 months of 2 holders no other month has: 200 rows of 100 cells.
    const months = Array.from({ length: 100 }, (_, at) =>
      month(new Date(Date.UTC(2020, at, 28)).toISOString().slice(0, 10), [
        holder(`A${at}`, [row(`ALPHA ${at}`, 300, 300)]),
        holder(`B${at}`, [row(`BETA ${at}`, 200, 200)]),
      ])
    )
    const last = months.at(-1)?.dataDate ?? ""
    const server = document.createElement("div")
    server.innerHTML = renderToString(
      <EveryMonth months={months} selected={last} />
    )
    expect(server.querySelectorAll("tbody tr")).toHaveLength(60)
    await act<void>(() =>
      root.render(<EveryMonth months={months} selected={last} />)
    )
    expect(
      rows()
        .slice(0, 2)
        .map(([name]) => name)
    ).toEqual(["ALPHA 99", "BETA 99"])
    expect(rows()).toHaveLength(200)
  })

  test("shades every cell the lightest when every holder holds 0%", async () => {
    await act<void>(() =>
      root.render(
        <EveryMonth
          months={[month("2026-10-30", [holder("ZERO", [row("ZERO", 1, 0)])])]}
          selected="2026-10-30"
        />
      )
    )
    const cell = grid()?.querySelector<HTMLElement>("tbody td")
    expect(cell?.style.getPropertyValue("--shade")).toBe("8%")
  })
  test("outlines the selected month and sorts by it, holders not listed in it last and greyed", async () => {
    await render("2026-09-30")
    expect(
      grid()?.querySelector('thead th[aria-current="true"]')?.textContent
    ).toBe("Sep 26")
    expect(rows().map(([name, ...cells]) => [name, cells[2]])).toEqual([
      ["ADARO STRATEGIC INVESTMENTS", "41.10▲"],
      ["PT PARAGA ARTAMIDA", "5.20"],
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
