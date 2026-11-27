// @vitest-environment happy-dom
import { StockCode } from "@workspace/relay"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test } from "vitest"

import {
  DailyHolders,
  type DailyHoldersProps,
} from "@/components/stocks/daily-holders"
import type {
  Above5SecuritiesAccount,
  Above5Holder,
  DailyHoldersDay,
} from "@/server/holdings/stock-page"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const account = (
  custodian: string,
  name: string,
  scripless: number,
  origin: Above5SecuritiesAccount["origin"] = "local",
  domicile = origin === "local" ? "INDONESIA" : "SINGAPORE"
): Above5SecuritiesAccount => ({ custodian, name, origin, domicile, scripless })

// A block of `accounts`, its % of 10,000 listed shares.
const block = (
  name: string,
  key: string,
  accounts: ReadonlyArray<Above5SecuritiesAccount>
): Above5Holder => {
  const scripless = accounts.reduce((sum, each) => sum + each.scripless, 0)
  return { name, key, scripless, percentageHundredths: scripless, accounts }
}

const day = (
  dataDate: string,
  holders: ReadonlyArray<Above5Holder>
): DailyHoldersDay => ({ dataDate, listedShares: 10_000, holders })

// 17 Nov: Alpha 10% (listed twice, a repeat block), Beta 7%, Gamma 6%.
// 18 Nov: Alpha up 100 shares at KB with its accounts shuffled, Beta renamed
// and up 20 by its Maybank account, Gamma gone, Delta new across two origins.
// 19 Nov: Delta gone, the rest unchanged. 16 Nov's report has no holder of
// the stock, so 17 Nov's are all New against it.
const alpha = (kb: number) => [
  account("PT KB VALBURY SEKURITAS", "ALPHA", kb),
  account("PT TRUST SEKURITAS", "ALPHA", 400),
]
const DAYS = [
  day("2026-11-16", []),
  day("2026-11-17", [
    block("PT ALPHA", "ALPHA", alpha(600)),
    block("BETA - REGISTRAR", "BETA REGISTRAR", [
      account("PT MAYBANK SEKURITAS INDONESIA", "BETA", 700),
    ]),
    block("ALPHA, PT", "ALPHA", alpha(600)),
    block("GAMMA", "GAMMA", [account("PT BANK DBS INDONESIA", "GAMMA", 600)]),
  ]),
  day("2026-11-18", [
    block("PT ALPHA", "ALPHA", [...alpha(700)].reverse()),
    block("BETA", "BETA", [
      account("PT MAYBANK SEKURITAS INDONESIA", "BETA", 720),
    ]),
    block("DELTA LTD", "DELTA LTD", [
      account(
        "PT CGS INTERNATIONAL SEKURITAS INDONESIA",
        "DELTA",
        300,
        "foreign"
      ),
      account("PT BCA SEKURITAS", "DELTA", 250),
    ]),
  ]),
  day("2026-11-19", [
    block("PT ALPHA", "ALPHA", alpha(700)),
    block("BETA", "BETA", [
      account("PT MAYBANK SEKURITAS INDONESIA", "BETA", 720),
    ]),
  ]),
]

const container = document.createElement("div")
document.body.append(container)
const root = createRoot(container)
afterEach(() => act(() => root.render(null)))

const render = (props: Partial<DailyHoldersProps>) =>
  act<void>(() =>
    root.render(
      <DailyHolders
        code={StockCode.make("ENRG")}
        days={DAYS}
        day={undefined}
        onDay={() => {}}
        {...props}
      />
    )
  )

const text = () => container.textContent ?? ""

const table = () => container.querySelector('table[aria-label="Daily holders"]')

// Chips in `cell`, space-separated.
const chips = (cell: Element) =>
  [...cell.querySelectorAll("[data-chip]")]
    .map((chip) => chip.textContent)
    .join(" ")

// Each holder row's name and cells: move, through, lots, stake, change.
const holderRows = () =>
  [...(table()?.querySelectorAll("tbody tr[data-holder]") ?? [])].map((tr) => [
    tr.querySelector("[data-holder-name]")?.textContent,
    ...[...tr.querySelectorAll(":scope > td:not([data-trend-cell])")].map(
      (cell) =>
        cell.hasAttribute("data-through") ? chips(cell) : cell.textContent
    ),
  ])

const holderRow = (name: string) =>
  [...(table()?.querySelectorAll("tbody tr[data-holder]") ?? [])].find(
    (tr) => tr.querySelector("[data-holder-name]")?.textContent === name
  )

// The account rows under `name`'s row, up to the next holder: the broker
// chip, then each cell's text without it.
const accountsOf = (name: string) => {
  const rows: Array<Array<string | null>> = []
  let next = holderRow(name)?.nextElementSibling
  while (next?.hasAttribute("data-account")) {
    rows.push([
      chips(next),
      ...[...next.querySelectorAll("td")].map((cell) => {
        const copy = cell.cloneNode(true) as Element
        copy.querySelectorAll("[data-chip]").forEach((chip) => chip.remove())
        return copy.textContent
      }),
    ])
    next = next.nextElementSibling
  }
  return rows
}

const trendOf = (name: string) =>
  [...(holderRow(name)?.querySelectorAll<SVGElement>("[data-cell]") ?? [])].map(
    (bar) => bar.dataset.cell
  )

const select = () =>
  container.querySelector<HTMLSelectElement>('select[aria-label="Trading day"]')

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe("Daily holders", () => {
  test("opens the newest day, after the stock's first held day", async () => {
    await render({})
    expect(select()?.value).toBe("2026-11-19")
    expect(
      [...(select()?.options ?? [])].map((option) => option.textContent)
    ).toEqual(["17 Nov 2026", "18 Nov 2026", "19 Nov 2026"])
    expect(text()).toContain(
      "2 holders hold 18.20% of listed shares · vs 18 Nov 2026: 0 new, 0 up, 0 down, 1 off list"
    )
  })

  test("steps through the days with previous, next and the list", async () => {
    const picked: Array<string> = []
    await render({ day: "2026-11-18", onDay: (each) => picked.push(each) })
    expect(select()?.value).toBe("2026-11-18")
    await act<void>(() => button("Previous trading day")?.click())
    await act<void>(() => button("Next trading day")?.click())
    const list = select() ?? document.createElement("select")
    list.value = "2026-11-17"
    await act(() => list.dispatchEvent(new Event("change", { bubbles: true })))
    expect(picked).toEqual(["2026-11-17", "2026-11-19", "2026-11-17"])
    await render({ day: "2026-11-17" })
    expect(button("Previous trading day")?.disabled).toBe(true)
    await render({})
    expect(button("Next trading day")?.disabled).toBe(true)
  })

  test("shows each holder's move by shares, lots, stake and change", async () => {
    await render({ day: "2026-11-18" })
    const header = [...(table()?.querySelectorAll("thead th") ?? [])].map(
      (th) => th.textContent
    )
    expect(header).toEqual([
      "Holder",
      "Move",
      "Through",
      "Lots",
      "Stake",
      "Change",
      "Trend",
    ])
    expect(holderRows()).toEqual([
      // Only the KB account moved.
      ["PT ALPHA", "Up", "CP", "+1", "10.00% → 11.00%", "+1.00%"],
      ["BETA", "Up", "ZP", "+0.2", "7.00% → 7.20%", "+0.20%"],
      // Every account of a New holder, largest first.
      ["DELTA LTD", "New", "YU SQ", "+5.5", "under 5% → 5.50%", "—"],
      // The accounts an Off-list holder held the day before.
      ["GAMMA", "Off list", "Custodian", "−6", "6.00% → under 5%", "—"],
    ])
    expect(text()).toContain(
      "3 holders hold 23.70% of listed shares · vs 17 Nov 2026: 1 new, 2 up, 0 down, 1 off list"
    )
  })

  test("names a holder's aliases, rename, origin and accounts", async () => {
    await render({ day: "2026-11-17" })
    const alphaRow = holderRow("PT ALPHA")?.textContent
    expect(alphaRow).toContain("Also listed as ALPHA, PT")
    expect(alphaRow).toContain("Local")
    expect(alphaRow).toContain("2 accounts")
    expect(holderRows().map(([name]) => name)).toEqual([
      "PT ALPHA",
      "BETA - REGISTRAR",
      "GAMMA",
    ])
    await render({ day: "2026-11-18" })
    expect(holderRow("PT ALPHA")?.textContent).not.toContain("Also listed")
    expect(holderRow("BETA")?.textContent).toContain(
      "Renamed from BETA - REGISTRAR"
    )
    expect(holderRow("BETA")?.textContent).toContain("1 account")
    expect(holderRow("DELTA LTD")?.textContent).toContain("Mixed")
  })

  test("lists every account under its holder, largest first, paired across days", async () => {
    await render({ day: "2026-11-18" })
    // Broker, custodian and account, origin and domicile, change, lots.
    expect(accountsOf("PT ALPHA")).toEqual([
      [
        "CP",
        "PT KB VALBURY SEKURITASALPHA",
        "Local · INDONESIA",
        "+1",
        "7 lots",
      ],
      ["BR", "PT TRUST SEKURITASALPHA", "Local · INDONESIA", "±0", "4 lots"],
    ])
    // A new holder's accounts have no change.
    expect(accountsOf("DELTA LTD")).toEqual([
      [
        "YU",
        "PT CGS INTERNATIONAL SEKURITAS INDONESIADELTA",
        "Foreign · SINGAPORE",
        "",
        "3 lots",
      ],
      ["SQ", "PT BCA SEKURITASDELTA", "Local · INDONESIA", "", "2.5 lots"],
    ])
  })

  test("keeps every earlier holder below the day's Off list, the latest off it first", async () => {
    await render({})
    expect(holderRows().map(([name, move]) => [name, move])).toEqual([
      ["PT ALPHA", "Unchanged"],
      ["BETA", "Unchanged"],
      ["DELTA LTD", "Off list"],
      ["GAMMA", "Off list since 18 Nov 2026"],
    ])
    expect(text()).toContain("Earlier holders · 1")
    expect(holderRow("GAMMA")?.getAttribute("data-off-list")).toBe("true")
  })

  test("renders every row of a day longer than the server renders", async () => {
    const holders = Array.from({ length: 150 }, (_, at) =>
      block(`HOLDER ${at}`, `H${at}`, [
        account("PT TRUST SEKURITAS", `HOLDER ${at}`, 500 - at),
      ])
    )
    await render({ days: [day("2026-11-19", holders)] })
    expect(text()).toContain("150 holders hold")
    expect(table()?.querySelectorAll("tbody tr")).toHaveLength(300)
  })

  test("splits listed shares among the day's holders on the bar", async () => {
    await render({ day: "2026-11-18" })
    expect(
      [
        ...container.querySelectorAll<HTMLElement>(
          '[aria-label="Ownership of listed shares"] > *'
        ),
      ].map((segment) => segment.title)
    ).toEqual([
      "PT ALPHA 11.00% · 11 lots",
      "BETA 7.20% · 7.2 lots",
      "DELTA LTD 5.50% · 5.5 lots",
      "Holders under 5% 76.30% · 76.3 lots",
    ])
    expect(
      [...container.querySelectorAll('[aria-label="Ownership legend"] li')].map(
        (item) => item.textContent
      )
    ).toEqual([
      "PT ALPHA 11.00%",
      "BETA 7.20%",
      "DELTA LTD 5.50%",
      "Under 5% 76.30%",
    ])
  })

  test("trends each holder's change in lots, in and out marked", async () => {
    await render({ day: "2026-11-18" })
    expect(trendOf("PT ALPHA")).toEqual(["in", "up"])
    expect(trendOf("BETA")).toEqual(["in", "up"])
    expect(trendOf("DELTA LTD")).toEqual(["in"])
    expect(trendOf("GAMMA")).toEqual(["in", "out"])
    // An unchanged day has no bar.
    await render({})
    expect(trendOf("PT ALPHA")).toEqual(["in", "up"])
    expect(trendOf("DELTA LTD")).toEqual(["in", "out"])
  })

  test("shows no moves or changes on the stock's first parsed day", async () => {
    await render({ days: DAYS.slice(1), day: "2026-11-17" })
    expect(text()).toContain(
      "3 holders hold 23.00% of listed shares · First day parsed, nothing to compare"
    )
    expect(holderRows()).toEqual([
      ["PT ALPHA", "", "", "—", "10.00%", "—"],
      ["BETA - REGISTRAR", "", "", "—", "7.00%", "—"],
      ["GAMMA", "", "", "—", "6.00%", "—"],
    ])
    expect(accountsOf("PT ALPHA").map((cells) => cells[3])).toEqual(["", ""])
  })

  test("shows each account's broker code, a closed member's from its name, or Custodian", async () => {
    const custodians = [
      "PT INDO PREMIER SEKURITAS",
      "PANIN SEKURITAS Tbk, PT",
      "PT Sinergi Millenium Sekuritas (REKENING TAMPUNGAN KSEI UNTUK CLOSED MEMBER-SM001)",
      "PT POOL ADVISTA SEKURITAS (TAMP QA001)",
      "PT EKUATOR SWARNA SEKURITAS (TAMPUNGAN MK001)",
      "PT BANK DBS INDONESIA",
    ]
    await render({
      days: [
        day("2026-11-19", [
          block(
            "OMEGA",
            "OMEGA",
            custodians.map((custodian, at) =>
              account(custodian, "OMEGA", 1000 - at * 100)
            )
          ),
        ]),
      ],
    })
    expect(accountsOf("OMEGA").map(([broker]) => broker)).toEqual([
      "PD",
      "GR",
      "SM",
      "QA",
      "MK",
      "Custodian",
    ])
  })

  test("says so for a stock without an above-5% holder on any day", async () => {
    await render({ days: [day("2026-11-19", [])] })
    expect(text()).toContain(
      "ENRG has no holder above 5% on any day parsed from IDX's daily report."
    )
    expect(table()).toBeNull()
  })
})
