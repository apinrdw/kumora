// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, test } from "vitest"

import { ParseCoverageCard } from "@/components/admin/archive/parse-coverage-card"
import { RunId } from "@/server/archive/run"
import type {
  ParseCoverage,
  ParseCoverageMonth,
  ParseCoverageState,
} from "@/server/holdings/parse-coverage"

import { renderAt } from "../../../support/render-at.tsx"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

const sha = (digit: string) => digit.repeat(64)

const month = (
  date: string,
  state: ParseCoverageState,
  detail: Partial<ParseCoverageMonth> = {}
): ParseCoverageMonth => ({
  date,
  state,
  newestSha256: sha("0"),
  parsed: null,
  staleCauses: [],
  failure: null,
  ...detail,
})

const card = (coverage: ParseCoverage) =>
  renderAt("/", () => (
    <ParseCoverageCard grids={[{ title: "Securities holdings", coverage }]} />
  ))

describe("a parse coverage card", () => {
  test("says no report is archived yet before any month", async () => {
    const html = text(await card([]))
    expect(html).toContain("Parse coverage")
    expect(html).toContain("No Securities holdings report is archived yet.")
  })

  test("marks each archived month's state and leaves the rest blank", async () => {
    const html = await card([
      {
        year: 2025,
        months: [
          ...Array.from({ length: 11 }, () => null),
          month("2025-12-31", "parsed"),
        ],
      },
      {
        year: 2026,
        months: [
          month("2026-01-30", "stale"),
          month("2026-02-27", "failed"),
          month("2026-03-31", "not-parsed"),
          ...Array.from({ length: 9 }, () => null),
        ],
      },
    ])
    expect(html).toContain('aria-label="Securities holdings parse coverage"')
    expect(text(html)).toContain(
      "Parsed Stale Failed Not parsed yet Securities holdings"
    )
    expect(html).toContain('title="December 2025: Parsed (2025-12-31)"')
    expect(html).toContain('title="January 2026: Stale (2026-01-30)"')
    expect(html).toContain('title="February 2026: Failed (2026-02-27)"')
    expect(html).toContain('title="March 2026: Not parsed yet (2026-03-31)"')
    // Each year's row: its year, then a label for each archived month only.
    expect(text(html)).toContain("2025 Parsed 2026 Stale Failed Not parsed yet")
    expect(html.match(/title="/g)).toHaveLength(4)
  })
})

describe("a parse coverage month's detail", () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  afterEach(() => act(() => root.render(null)))

  const COVERAGE: ParseCoverage = [
    {
      year: 2026,
      months: [
        ...Array.from({ length: 7 }, () => null),
        month("2026-08-31", "parsed", {
          newestSha256: sha("1"),
          parsed: {
            sha256: sha("1"),
            parserVersion: 2,
            parsedAt: "2026-11-14T04:00:00.000Z",
            stockCount: 912,
          },
        }),
        month("2026-09-30", "stale", {
          newestSha256: sha("2"),
          parsed: {
            sha256: sha("3"),
            parserVersion: 1,
            parsedAt: "2026-10-14T04:00:00.000Z",
            stockCount: 905,
          },
          staleCauses: ["newer-version", "parser-updated"],
        }),
        month("2026-10-30", "failed", {
          newestSha256: sha("4"),
          parsed: {
            sha256: sha("5"),
            parserVersion: 2,
            parsedAt: "2026-11-01T04:00:00.000Z",
            stockCount: 910,
          },
          failure: {
            message: "The header isn't the known one",
            run: RunId.make("cron-2026-11-15"),
          },
        }),
        month("2026-11-28", "not-parsed", { newestSha256: sha("6") }),
        null,
      ],
    },
  ]

  const render = () =>
    act(() =>
      root.render(
        <ParseCoverageCard
          grids={[{ title: "Securities holdings", coverage: COVERAGE }]}
        />
      )
    )

  const cell = (name: string) => {
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label")?.startsWith(name)
    )
    if (button === undefined) throw new Error(`no ${name} cell`)
    return button
  }

  const select = (name: string) => act(() => cell(name).click())

  // The panel's heading, then each detail's label and value, space-separated.
  const panel = () => {
    const section = container.querySelector(
      '[aria-label="Securities holdings month detail"]'
    )
    return section === null
      ? undefined
      : [...section.querySelectorAll("h4, dt, dd")]
          .map((element) => element.textContent)
          .join(" ")
  }

  test("shows nothing selected at first", async () => {
    await render()
    expect(panel()).toBeUndefined()
    expect(cell("August 2026").getAttribute("aria-pressed")).toBe("false")
  })

  test("shows a parsed month's versions, parse time and stock count", async () => {
    await render()
    await select("August 2026")
    expect(cell("August 2026").getAttribute("aria-pressed")).toBe("true")
    const detail = panel()
    expect(detail).toContain("August 2026 2026-08-31 Parsed")
    expect(detail).toContain("Newest version 111111111111")
    expect(detail).toContain("Parsed from 111111111111")
    expect(detail).toContain("Parser version 2")
    expect(detail).toContain("Parsed at Nov 14, 11:00 WIB")
    expect(detail).toContain("Stocks 912")
    expect(detail).not.toContain("Stale because")
    expect(detail).not.toContain("Failure")
  })

  test("says why a stale month is stale", async () => {
    await render()
    await select("September 2026")
    const detail = panel()
    expect(detail).toContain("September 2026 2026-09-30 Stale")
    expect(detail).toContain("Newest version 222222222222")
    expect(detail).toContain("Parsed from 333333333333")
    expect(detail).toContain(
      "Stale because Newer version archived, parser updated"
    )
  })

  test("shows a failed month's message and run, and its older parsed version", async () => {
    await render()
    await select("August 2026")
    await select("October 2026")
    expect(cell("August 2026").getAttribute("aria-pressed")).toBe("false")
    const detail = panel()
    expect(detail).toContain("October 2026 2026-10-30 Failed")
    expect(detail).not.toContain("August")
    expect(detail).toContain("Newest version 444444444444")
    expect(detail).toContain("Parsed from 555555555555")
    expect(detail).toContain("Stocks 910")
    expect(detail).toContain("Failure The header isn't the known one")
    expect(detail).toContain("Run cron-2026-11-15")
  })

  test("hides the detail when the selected month is pressed again", async () => {
    await render()
    await select("August 2026")
    await select("August 2026")
    expect(panel()).toBeUndefined()
    expect(cell("August 2026").getAttribute("aria-pressed")).toBe("false")
  })

  test("says a month not parsed yet has no parsed holdings", async () => {
    await render()
    await select("November 2026")
    const detail = panel()
    expect(detail).toContain("Newest version 666666666666")
    expect(detail).toContain("No parsed holdings")
    expect(detail).not.toContain("Parsed from")
  })
})
