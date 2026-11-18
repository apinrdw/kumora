// @vitest-environment happy-dom
import { StockCode } from "@workspace/relay"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test } from "vitest"

import {
  MajorHolders,
  type MajorHoldersProps,
} from "@/components/stocks/major-holders"
import type {
  Above1Holder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Row = Above1Holder["rows"][number]

const row = (
  name: string,
  total: number,
  hundredths: number,
  more: Partial<Row> = {}
): Row => ({
  name,
  classification: "corporate",
  type: "CP",
  origin: "local",
  domicile: "INDONESIA",
  controller: undefined,
  total,
  percentageHundredths: hundredths,
  ...more,
})

const holder = (
  key: string,
  rows: ReadonlyArray<Row>,
  scrip = 0
): Above1Holder => {
  const total = rows.reduce((sum, each) => sum + each.total, 0)
  return {
    key,
    scripless: total - scrip,
    scrip,
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

// Aug has no rows for the stock. Sep: Adaro 41.00%, Permadi 3.48%, Gamma
// 2.00%. Oct: Adaro up, Permadi unchanged on more shares, Gamma off list,
// Paraga new on two rows, a quarter of it in scrip.
const MONTHS = [
  month("2026-08-31", []),
  month("2026-09-30", [
    holder("ADARO", [row("ADARO STRATEGIC INVESTMENTS", 3_200_000_000, 4100)]),
    holder("PERMADI", [
      row("T PERMADI RACHMAT", 270_000_000, 348, { type: "ID" }),
    ]),
    holder("GAMMA", [row("GAMMA CAPITAL", 155_000_000, 200)]),
  ]),
  month("2026-10-30", [
    holder("ADARO", [
      row("ADARO STRATEGIC INVESTMENTS", 3_210_000_000, 4110, {
        controller: "controller",
      }),
    ]),
    holder(
      "PARAGA",
      [
        row("PARAGA ARTAMIDA, PT", 100_000_000, 130, {
          classification: undefined,
          type: undefined,
          origin: undefined,
          domicile: undefined,
        }),
        row("PT PARAGA ARTAMIDA", 300_000_000, 390, {
          origin: "foreign",
          domicile: "SINGAPORE",
        }),
      ],
      100_000_000
    ),
    holder("PERMADI", [
      row("T PERMADI RACHMAT", 270_000_400, 348, {
        classification: "individual",
        type: "ID",
        controller: "affiliate",
      }),
    ]),
  ]),
]

const container = document.createElement("div")
document.body.append(container)
const root = createRoot(container)
afterEach(() => act(() => root.render(null)))

const render = (props: Partial<MajorHoldersProps>) =>
  act(() =>
    root.render(
      <MajorHolders
        code={StockCode.make("AADI")}
        months={MONTHS}
        month={undefined}
        onMonth={() => {}}
        {...props}
      />
    )
  )

const text = () => container.textContent ?? ""

const table = () => container.querySelector('table[aria-label="Major holders"]')

// Each row's cells after the holder: chip, %, shares, in scrip.
const tableCells = () =>
  [...(table()?.querySelectorAll("tbody tr") ?? [])].map((tr) => [
    tr.querySelector("[data-holder-name]")?.textContent,
    ...[...tr.querySelectorAll("td")].map((cell) => cell.textContent),
  ])

const meta = (name: string) =>
  [...(table()?.querySelectorAll("tbody tr") ?? [])]
    .find((tr) => tr.querySelector("[data-holder-name]")?.textContent === name)
    ?.querySelector("[data-holder-meta]")?.textContent

// The ownership bar's segments: title, width and tone.
const segments = () =>
  [
    ...container.querySelectorAll<HTMLElement>(
      '[aria-label="Ownership of listed shares"] > *'
    ),
  ].map((segment) => [segment.title, segment.style.width, segment.dataset.tone])

const legend = () =>
  [...container.querySelectorAll('[aria-label="Ownership legend"] li')].map(
    (item) => item.textContent
  )

describe("Major holders", () => {
  test("opens the newest month, holders by % against the month before", async () => {
    await render({})
    expect(text()).toContain(
      "3 holders hold 49.78% of listed shares · vs Sep 2026: 1 new, 1 up, 0 down, 1 off list"
    )
    const header = [...(table()?.querySelectorAll("thead th") ?? [])].map(
      (th) => th.textContent
    )
    expect(header).toEqual([
      "Holder",
      "vs Sep 26",
      "% of listed",
      "Shares",
      "In scrip",
    ])
    expect(tableCells()).toEqual([
      [
        "ADARO STRATEGIC INVESTMENTS",
        "Up",
        "41.10%+0.10 pp",
        "3.21 B+10 M",
        "0%",
      ],
      ["PT PARAGA ARTAMIDA", "New", "5.20%", "400 M", "25%"],
      ["T PERMADI RACHMAT", "Unchanged", "3.48%±0.00 pp", "270 M+400", "0%"],
      ["GAMMA CAPITAL", "Off list", "—was 2.00%", "—", "—"],
    ])
    expect(
      table()
        ?.querySelector("tbody tr:last-child")
        ?.getAttribute("data-off-list")
    ).toBe("true")
    expect(text()).toContain(
      "Percent of listed shares, scrip included, as IDX publishes it. Holders under 1% are not listed."
    )
  })

  test("splits the month's listed shares among its holders and Under 1% in the ownership bar", async () => {
    await render({})
    expect(segments()).toEqual([
      ["ADARO STRATEGIC INVESTMENTS 41.10%", "41.1%", "gold"],
      ["PT PARAGA ARTAMIDA 5.20%", "5.2%", "blue"],
      ["T PERMADI RACHMAT 3.48%", "3.48%", "gold"],
      ["Holders under 1% 50.22%", "50.22%", "under"],
    ])
    expect(legend()).toEqual([
      "ADARO STRATEGIC INVESTMENTS 41.10%",
      "PT PARAGA ARTAMIDA 5.20%",
      "T PERMADI RACHMAT 3.48%",
      "Under 1% 50.22%",
      "Gold = controller or affiliate",
    ])
    await render({ month: "2026-09" })
    expect(segments().map(([, width, tone]) => [width, tone])).toEqual([
      ["41%", "blue"],
      ["3.48%", "blue"],
      ["2%", "blue"],
      ["53.52%", "under"],
    ])
  })

  test("fills the ownership bar to 100% with no Under 1% when the published % sum past 100%", async () => {
    await render({
      months: [
        month("2026-10-30", [
          holder("A", [row("ALPHA", 600, 6000)]),
          holder("B", [row("BETA", 500, 5000)]),
        ]),
      ],
    })
    const widths = segments().map(([, width]) => Number.parseFloat(width ?? ""))
    expect(widths[0]).toBeCloseTo(54.55, 2)
    expect(widths[1]).toBeCloseTo(45.45, 2)
    expect(widths[2]).toBe(0)
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 6)
    expect(legend()).toContain("Under 1% 0.00%")
  })

  test("names the top 6 holders in the ownership bar's legend, then how many more", async () => {
    const eight = Array.from({ length: 8 }, (_, index) =>
      holder(`H${index}`, [row(`HOLDER ${index}`, 1000 - index, 900 - index)])
    )
    await render({ months: [month("2026-10-30", eight)] })
    expect(segments()).toHaveLength(9)
    expect(legend()).toEqual([
      "HOLDER 0 9.00%",
      "HOLDER 1 8.99%",
      "HOLDER 2 8.98%",
      "HOLDER 3 8.97%",
      "HOLDER 4 8.96%",
      "HOLDER 5 8.95%",
      "+2 more",
      "Under 1% 28.28%",
      "Gold = controller or affiliate",
    ])
  })

  test("badges each holder's controller flag, classification or type, origin and foreign domicile", async () => {
    await render({})
    expect(meta("ADARO STRATEGIC INVESTMENTS")).toBe(
      "Controller·Corporate·Local"
    )
    expect(meta("T PERMADI RACHMAT")).toBe(
      "Affiliate of controller·Individual·Local"
    )
    expect(meta("PT PARAGA ARTAMIDA")).toBe("Corporate·Foreign·SINGAPORE")
    await render({ month: "2026-09" })
    expect(meta("T PERMADI RACHMAT")).toBe("Corporate·Local")
  })

  test("expands a holder's rows in the report", async () => {
    await render({})
    const toggle = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "2 rows in the report"
    )
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
    await act(() => toggle?.click())
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
    expect(text()).toContain("PARAGA ARTAMIDA, PT · 100 M · 1.30%")
    expect(text()).toContain("PT PARAGA ARTAMIDA · 300 M · 3.90%")
    expect(meta("PARAGA ARTAMIDA, PT")).toBeUndefined()
  })

  test("shows no chips in the stock's first month", async () => {
    await render({ month: "2026-09" })
    expect(text()).toContain(
      "3 holders hold 46.48% of listed shares · First month reported, nothing to compare"
    )
    expect(tableCells().map((cells) => cells[1])).toEqual(["", "", ""])
  })

  test("picks a month from its tabs, a month without rows disabled", async () => {
    const picked: Array<string> = []
    await render({ onMonth: (dataDate) => picked.push(dataDate) })
    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Month"] button'
      ),
    ]
    expect(tabs.map((tab) => tab.getAttribute("aria-disabled"))).toEqual([
      "true",
      "false",
      "false",
    ])
    await act(() => tabs[0]?.click())
    await act(() => tabs[1]?.click())
    expect(picked).toEqual(["2026-09-30"])
  })

  test("says a stock in no above-1% report has no ≥1% holders", async () => {
    await render({ months: [month("2026-10-30", [])] })
    expect(text()).toContain(
      "AADI isn't in any IDX above-1% report, so its ≥1% holders aren't shown."
    )
    expect(table()).toBeNull()
  })
})
