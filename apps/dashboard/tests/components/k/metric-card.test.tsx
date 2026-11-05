import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { KMetricCard } from "@/components/k/metric-card"
import type { KMetricCardProps } from "@/components/k/metric-card"

const AS_OF = "2026-10-28T07:45:00Z"

function render(props: Partial<KMetricCardProps> = {}) {
  return renderToStaticMarkup(
    <KMetricCard label="Net beli asing" value="Rp1,2 T" {...props} />
  )
}

/** The class list of the element holding the headline value. */
function valueClass(html: string) {
  return /class="(num flex items-baseline[^"]*)"/.exec(html)?.[1] ?? ""
}

describe("KMetricCard", () => {
  test("loading renders the metric skeleton instead of the value", () => {
    const html = render({ loading: true })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain("Rp1,2 T")
  })

  test("labels the group and shows the value with its unit", () => {
    const html = render({ unit: "lembar" })
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="Net beli asing"')
    expect(html).toContain("Rp1,2 T")
    expect(html).toContain(">lembar</span>")
    expect(valueClass(html)).toContain("text-foreground")
    expect(valueClass(html)).toContain("text-[28px]")
  })

  test("compact size uses the smaller value type", () => {
    expect(valueClass(render({ size: "compact" }))).toContain("text-xl")
  })

  test("a missing value renders a dash and the no-data copy, never a unit or zero", () => {
    const html = render({ value: null, unit: "lembar" })
    expect(html).toContain("—")
    expect(html).not.toContain("lembar")
    expect(html).toContain("Belum ada data yang cukup untuk periode ini.")
    expect(valueClass(html)).toContain("text-muted-foreground")
  })

  test("a stale metric gets the warning border and a muted value", () => {
    const html = render({ freshness: "stale", asOf: AS_OF })
    expect(html).toContain("border-warning")
    expect(html).toContain("STALE")
    expect(valueClass(html)).toContain("text-secondary-text")
  })

  test("shows the change with its period, using the pre-formatted text when given", () => {
    const html = render({ change: -2.5, period: "1H" })
    expect(html).toContain("−2,50%")
    expect(html).toContain("turun")
    expect(html).toContain(">1H</span>")

    const custom = render({ change: 3, changeDisplay: "+Rp3 M" })
    expect(custom).toContain("+Rp3 M")
    expect(custom).not.toContain("1H")
  })

  test("a value without a change shows neither a delta nor the no-data copy", () => {
    const html = render()
    expect(html).not.toContain("naik")
    expect(html).not.toContain("Belum ada data")
  })

  test("shows the provenance line", () => {
    const html = render({ source: "IDX", asOf: AS_OF })
    expect(html).toContain("IDX")
    expect(html).toContain("per 14.45 WIB")
  })
})
