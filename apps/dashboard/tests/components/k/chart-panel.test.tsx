import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { CANDLE_LEGEND, KChartPanel } from "@/components/k/chart-panel"
import type { KChartPanelProps } from "@/components/k/chart-panel"
import { EMPTY } from "@/components/k/empty-state"

const AS_OF = "2026-10-28T07:45:00Z"

function render(props: Partial<KChartPanelProps> = {}) {
  return renderToStaticMarkup(
    <KChartPanel
      title="Harga BBCA"
      freshness="eod"
      source="Feed harga"
      unit="Rp per saham"
      summary="Harga naik 2% dalam sepekan."
      {...props}
    >
      <svg data-testid="chart" />
    </KChartPanel>
  )
}

describe("KChartPanel", () => {
  test("is a titled region with a screen-reader summary, unit, timezone, and source", () => {
    const html = render({ asOf: AS_OF })
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Harga BBCA"')
    expect(html).toContain("<h3")
    expect(html).toContain(
      '<p class="sr-only">Harga naik 2% dalam sepekan.</p>'
    )
    expect(html).toContain("Satuan: Rp per saham · Zona waktu WIB")
    expect(html).toContain("Feed harga")
    expect(html).toContain("per 14:45 WIB")
    expect(html).toContain('data-testid="chart"')
  })

  test("a stale panel gets the warning border and dims the chart", () => {
    const html = render({ freshness: "stale" })
    expect(html).toContain("border-warning")
    expect(html).toContain("opacity-85")
    expect(render()).not.toContain("opacity-85")
  })

  test("renders timeframe tabs and extra actions only when given", () => {
    const bare = render()
    expect(bare).not.toContain('aria-label="Interval"')

    const html = render({
      timeframes: ["1H", "1M"],
      timeframe: "1M",
      actions: <button type="button">Unduh</button>,
    })
    expect(html).toContain('aria-label="Interval"')
    expect(html).toContain("1H")
    expect(html).toContain("Unduh")

    const actionsOnly = render({
      actions: <button type="button">Unduh</button>,
    })
    expect(actionsOnly).toContain("Unduh")
    expect(actionsOnly).not.toContain('aria-label="Interval"')
  })

  test("non-ready states replace the chart", () => {
    const loading = render({ state: { status: "loading" } })
    expect(loading).toContain('aria-busy="true"')
    expect(loading).not.toContain('data-testid="chart"')

    const restricted = render({ state: { status: "restricted" } })
    expect(restricted).toContain(EMPTY["no-access"].title)
    expect(restricted).not.toContain('data-testid="chart"')
  })

  test("draws the legend with bar, dashed, and solid marks", () => {
    const html = render({
      legend: [...CANDLE_LEGEND, { label: "Harga", color: "price" }],
    })
    expect(html).toContain('aria-label="Legenda"')
    expect(html).toContain("Harga naik")
    expect(html).toContain("background:var(--semantic-up)")
    expect(html).toContain(
      "repeating-linear-gradient(90deg, var(--chart-vwap) 0 3px, transparent 3px 5px)"
    )
    expect(html).toMatch(/w-3[^"]*"[^>]*background:var\(--text-secondary\)/)
  })

  test("omits the legend when empty", () => {
    expect(render()).not.toContain("Legenda")
  })
})
