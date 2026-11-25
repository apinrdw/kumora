// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test } from "vitest"

import { HolderMovesPage } from "@/components/holder-moves/holder-moves"
import type { HolderId } from "@/lib/holder-identity"
import type { MoveKind } from "@/domain/holdings"
import type { HolderMoves, MoveFilter, MoveLine } from "@/lib/holder-moves"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const line = (
  code: string,
  name: string,
  move: MoveLine["move"],
  through: ReadonlyArray<string>,
  stake: MoveLine["stake"],
  shareChange?: number
): MoveLine => ({
  code: StockCode.make(code),
  issuerName: `${code} TBK`,
  holder: `${name}#1` as HolderId,
  name,
  aliases: [],
  renamedFrom: undefined,
  move,
  through: through.map((each) =>
    each === "custodian" ? "custodian" : BrokerCode.make(each)
  ),
  shareChange,
  stake,
  percentageChange:
    stake.before !== undefined && stake.now !== undefined
      ? stake.now - stake.before
      : undefined,
  trend: [
    null,
    1000,
    move === "new" ? "in" : move === "off list" ? "out" : -500,
  ],
})

const LINES = [
  {
    ...line(
      "ENRG",
      "MAYBANK SEKURITAS INDONESIA",
      "up",
      ["ZP"],
      {
        before: 657,
        now: 658,
      },
      20_000
    ),
    renamedFrom: "PT MAYBANK SEKURITAS INDONESIA - REGISTRAR",
  },
  line(
    "ENRG",
    "CGS INTERNATIONAL SEKURITAS INDONESIA",
    "down",
    ["YU"],
    {
      before: 685,
      now: 684,
    },
    -500
  ),
  line(
    "NSSS",
    "PT SAMUEL TUMBUH BERSAMA",
    "new",
    ["IF"],
    { now: 3430 },
    8_162_940_500
  ),
  line(
    "NSSS",
    "PARADISO RESOURCES LTD",
    "off list",
    ["custodian"],
    { before: 531 },
    -1_263_800_000
  ),
]

const MOVES: HolderMoves = {
  kind: "daily",
  period: WibDate.make("2026-11-20"),
  against: WibDate.make("2026-11-19"),
  lines: LINES,
  counts: { new: 1, up: 1, down: 1, offList: 1 },
  stockCount: 2,
  rail: [
    {
      period: WibDate.make("2026-11-19"),
      counts: { new: 3, up: 6, down: 3, offList: 1 },
    },
    {
      period: WibDate.make("2026-11-20"),
      counts: { new: 1, up: 1, down: 1, offList: 1 },
    },
  ],
}

const container = document.createElement("div")
document.body.append(container)
const root = createRoot(container)
afterEach(() => act(() => root.render(null)))

// The page in a memory router, so its links resolve, holding the filter and
// the search as the route's URL would; each period and kind picked is
// recorded.
const render = async (
  moves: HolderMoves | undefined,
  kind: MoveKind = moves?.kind ?? "daily"
) => {
  const picked: Array<string> = []
  function Stateful() {
    const [filter, setFilter] = useState<MoveFilter>("all")
    const [search, setSearch] = useState("")
    return (
      <TooltipProvider>
        <HolderMovesPage
          kind={kind}
          moves={moves}
          filter={filter}
          search={search}
          onFilter={setFilter}
          onSearch={setSearch}
          onPeriod={(period) => picked.push(period)}
          onKind={(next) => picked.push(next)}
        />
      </TooltipProvider>
    )
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Stateful }),
    history: createMemoryHistory({ initialEntries: ["/holder-moves"] }),
  })
  await act(() => router.load())
  await act(async () => root.render(<RouterProvider router={router} />))
  return picked
}

const text = () => container.textContent ?? ""

const rows = () =>
  [...container.querySelectorAll("tbody tr[data-move]")].map((tr) =>
    [...tr.querySelectorAll(":scope > td, :scope > th")]
      .slice(0, 7)
      .map((cell) =>
        cell.hasAttribute("data-through")
          ? [...cell.querySelectorAll("[data-chip]")]
              .map((chip) => chip.textContent)
              .join(" ")
          : cell.textContent
      )
  )

const button = (name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.textContent?.startsWith(name)
  )
  expect(found).toBeDefined()
  return found as HTMLButtonElement
}

const typeSearch = (value: string) =>
  act(() => {
    const input = container.querySelector(
      'input[aria-label="Search stock, holder or broker"]'
    ) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

describe("Holder moves", () => {
  test("heads the day's moves and lists each mover's cells", async () => {
    await render(MOVES)
    expect(text()).toContain(
      "4 holders above 5% moved across 2 stocks on 20 Nov 2026, against 19 Nov 2026."
    )
    expect(rows()).toEqual([
      [
        "ENRGENRG TBK",
        "MAYBANK SEKURITAS INDONESIARenamed from PT MAYBANK SEKURITAS INDONESIA - REGISTRAR",
        "Up",
        "ZP",
        "+200",
        "6.57% → 6.58%",
        "+0.01%",
      ],
      [
        "ENRGENRG TBK",
        "CGS INTERNATIONAL SEKURITAS INDONESIA",
        "Down",
        "YU",
        "−5",
        "6.85% → 6.84%",
        "−0.01%",
      ],
      [
        "NSSSNSSS TBK",
        "PT SAMUEL TUMBUH BERSAMA",
        "New",
        "IF",
        "+81,629,405",
        "under 5% → 34.30%",
        "—",
      ],
      [
        "NSSSNSSS TBK",
        "PARADISO RESOURCES LTD",
        "Off list",
        "Custodian",
        "−12,638,000",
        "5.31% → under 5%",
        "—",
      ],
    ])
    // Each row's trend, its last bar the move.
    expect(
      [...container.querySelectorAll("tbody tr[data-move] svg")].map(
        (svg) => svg.querySelectorAll("rect[data-cell]").length
      )
    ).toEqual([2, 2, 2, 2])
  })

  test("filters by move, its buttons counting each", async () => {
    await render(MOVES)
    expect(
      [
        ...container.querySelectorAll(
          '[role="group"][aria-label="Move"] button'
        ),
      ].map((each) => each.textContent)
    ).toEqual(["All4", "New1", "Up1", "Down1", "Off list1"])
    await act(() => button("Off list").click())
    expect(button("Off list").getAttribute("aria-pressed")).toBe("true")
    expect(rows().map((row) => row[1])).toEqual(["PARADISO RESOURCES LTD"])
  })

  test("searches stock, issuer, holder and broker code", async () => {
    await render(MOVES)
    await typeSearch("zp")
    expect(rows().map((row) => row[1])).toEqual([
      "MAYBANK SEKURITAS INDONESIARenamed from PT MAYBANK SEKURITAS INDONESIA - REGISTRAR",
    ])
    await typeSearch("nsss")
    expect(rows()).toHaveLength(2)
    await typeSearch("paradiso")
    expect(rows().map((row) => row[0])).toEqual(["NSSSNSSS TBK"])
    await typeSearch("no such holder")
    expect(rows()).toEqual([])
    expect(text()).toContain("No holder matches. Clear the search or pick All.")
  })

  test("renders every move of a period longer than the server renders, and filters and searches them all", async () => {
    const lines = Array.from({ length: 250 }, (_, at) =>
      line("ENRG", `HOLDER ${String(at).padStart(3, "0")}`, "new", ["ZP"], {
        now: 9000 - at,
      })
    )
    await render({
      ...MOVES,
      lines,
      counts: { new: 250, up: 0, down: 0, offList: 0 },
    })
    expect(rows()).toHaveLength(250)
    expect(button("New").textContent).toBe("New250")
    expect(
      container.querySelectorAll('[aria-labelledby="crossed"] li')
    ).toHaveLength(250)
    await typeSearch("holder 249")
    expect(rows().map((row) => row[1])).toEqual(["HOLDER 249"])
    await typeSearch("")
    expect(rows()).toHaveLength(250)
  })

  test("links each row to its stock's Daily holders on the day", async () => {
    await render(MOVES)
    expect(
      [...container.querySelectorAll("tbody tr[data-move] a")].map((link) =>
        link.getAttribute("href")
      )
    ).toEqual([
      "/stocks/ENRG?holdersDay=2026-11-20#daily-holders",
      "/stocks/ENRG?holdersDay=2026-11-20#daily-holders",
      "/stocks/NSSS?holdersDay=2026-11-20#daily-holders",
      "/stocks/NSSS?holdersDay=2026-11-20#daily-holders",
    ])
  })

  test("rails the last days' counts, picking one on click", async () => {
    const picked = await render(MOVES)
    const day = button("19 Nov 2026: 9 new or up, 4 down or off list")
    expect(day.getAttribute("aria-pressed")).toBe("false")
    expect(
      button("20 Nov 2026: 2 new or up, 2 down or off list").getAttribute(
        "aria-pressed"
      )
    ).toBe("true")
    await act(() => day.click())
    expect(picked).toEqual(["2026-11-19"])
  })

  test("lists the holders that entered or left the list", async () => {
    await render(MOVES)
    const list = [...container.querySelectorAll("aside li")].map(
      (item) => item.textContent
    )
    expect(text()).toContain("Entered or left the list · 2")
    expect(list).toEqual([
      "NSSSPT SAMUEL TUMBUH BERSAMAIn at 34.30%",
      "NSSSPARADISO RESOURCES LTDOut 5.31% → under 5%",
    ])
  })

  test("says when nothing moved, or nothing is compared", async () => {
    await render({
      ...MOVES,
      lines: [],
      counts: { new: 0, up: 0, down: 0, offList: 0 },
      stockCount: 0,
    })
    expect(text()).toContain("0 holders above 5% moved across 0 stocks")
    expect(text()).toContain("No holder above 5% moved on 20 Nov 2026.")
    expect(text()).toContain("No holder entered or left.")
    await render({
      ...MOVES,
      period: WibDate.make("2026-06-11"),
      against: undefined,
      lines: [],
      rail: [],
    })
    expect(text()).toContain(
      "11 Jun 2026 is the first day parsed, so nothing to compare it with."
    )
  })

  test("says so before any day is parsed", async () => {
    await render(undefined)
    expect(text()).toContain("No day of IDX's above-5% report is parsed yet.")
    expect(container.querySelector("table")).toBeNull()
  })

  test("toggles between Daily and Monthly", async () => {
    const picked = await render(MOVES)
    const toggle = container.querySelector('[role="group"][aria-label="Kind"]')
    expect(
      [...(toggle?.querySelectorAll("button") ?? [])].map((each) => [
        each.textContent,
        each.getAttribute("aria-pressed"),
      ])
    ).toEqual([
      ["Daily", "true"],
      ["Monthly", "false"],
    ])
    await act(() => button("Monthly").click())
    expect(picked).toEqual(["monthly"])
  })

  test("offers the toggle before a month is parsed", async () => {
    const picked = await render(undefined, "monthly")
    expect(text()).toContain("No month of IDX's above-1% report is parsed yet.")
    await act(() => button("Daily").click())
    expect(picked).toEqual(["daily"])
  })
})

const MONTHLY: HolderMoves = {
  kind: "monthly",
  period: WibDate.make("2026-08-31"),
  against: WibDate.make("2026-04-30"),
  lines: [
    {
      ...line("TLKM", "DANANTARA", "new", [], { now: 5157 }, 5_000_000_000),
      trend: [null, "out", "in"],
    },
    line(
      "TLKM",
      "THE BANK OF NEW YORK MELLON",
      "up",
      [],
      { before: 594, now: 631 },
      362_889_000
    ),
    line("TRUE", "DJONI", "off list", [], { before: 509 }, -200_000_000),
  ],
  counts: { new: 1, up: 1, down: 0, offList: 1 },
  stockCount: 2,
  rail: [
    {
      period: WibDate.make("2026-04-30"),
      counts: { new: 3, up: 3, down: 5, offList: 6 },
    },
    {
      period: WibDate.make("2026-08-31"),
      counts: { new: 1, up: 1, down: 0, offList: 1 },
    },
  ],
}

describe("Holder moves, Monthly", () => {
  test("heads the month's ≥1% moves, with no Through column", async () => {
    await render(MONTHLY)
    expect(text()).toContain(
      "3 holders above 1% moved across 2 stocks in Aug 2026, against Apr 2026."
    )
    expect(
      [...container.querySelectorAll("thead th")].map((th) => th.textContent)
    ).toEqual(["Stock", "Holder", "Move", "Lots", "Stake", "Change", "Trend"])
    expect(rows().map((row) => row.slice(1, 6))).toEqual([
      ["DANANTARA", "New", "+50,000,000", "under 1% → 51.57%", "—"],
      [
        "THE BANK OF NEW YORK MELLON",
        "Up",
        "+3,628,890",
        "5.94% → 6.31%",
        "+0.37%",
      ],
      ["DJONI", "Off list", "−2,000,000", "5.09% → under 1%", "—"],
    ])
    expect(
      container
        .querySelector("tbody tr[data-move] svg")
        ?.getAttribute("aria-label")
    ).toBe("DANANTARA: change in lots on each of the last 3 months")
  })

  test("links each row to its stock's Major holders in the month", async () => {
    await render(MONTHLY)
    expect(
      [...container.querySelectorAll("tbody tr[data-move] a")].map((link) =>
        link.getAttribute("href")
      )
    ).toEqual([
      "/stocks/TLKM?holdersMonth=2026-08#major-holders",
      "/stocks/TLKM?holdersMonth=2026-08#major-holders",
      "/stocks/TRUE?holdersMonth=2026-08#major-holders",
    ])
  })

  test("rails the last months' counts, picking one on click", async () => {
    const picked = await render(MONTHLY)
    expect(text()).toContain("Last 2 months")
    await act(() =>
      button("Apr 2026: 6 new or up, 11 down or off list").click()
    )
    expect(picked).toEqual(["2026-04-30"])
    expect(
      [...container.querySelectorAll("aside li")].map(
        (item) => item.textContent
      )
    ).toEqual(["TLKMDANANTARAIn at 51.57%", "TRUEDJONIOut 5.09% → under 1%"])
  })

  test("says when the month is the first parsed", async () => {
    await render({
      ...MONTHLY,
      period: WibDate.make("2026-02-27"),
      against: undefined,
      lines: [],
      rail: [],
    })
    expect(text()).toContain(
      "Feb 2026 is the first month parsed, so nothing to compare it with."
    )
  })
})
