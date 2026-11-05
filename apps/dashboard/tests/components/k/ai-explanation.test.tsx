import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { IsoDateTime } from "@/domain/time"

import { AI_DISCLAIMER, KAIExplanation } from "@/components/k/ai-explanation"
import type { KAIExplanationProps } from "@/components/k/ai-explanation"

const AS_OF = IsoDateTime.make("2026-10-28T07:45:00Z")

const FULL: KAIExplanationProps = {
  modelVersion: "sm-flow 0.9.2",
  computedAt: AS_OF,
  hypothesis: "Asing mengakumulasi selama lima sesi.",
  inputs: [
    { label: "Broker summary", source: "IDX", asOf: AS_OF },
    { label: "Harga penutupan", source: "IDX" },
    { label: "Volume harian" },
  ],
  contributions: [
    { label: "Net beli asing", weight: 0.62 },
    { label: "Volume", weight: -1.4 },
  ],
  limitations: ["Tidak mencakup transaksi negosiasi"],
}

function render(props: KAIExplanationProps = {}) {
  return renderToStaticMarkup(<KAIExplanation {...props} />)
}

describe("KAIExplanation", () => {
  test("is always labelled as AI inference, with the model version as a badge", () => {
    const html = render({ modelVersion: "sm-flow 0.9.2" })
    expect(html).toContain('role="region"')
    expect(html).toContain("AI Inference")
    expect(html).toContain("sm-flow 0.9.2")
    expect(render()).not.toContain("sm-flow")
  })

  test("the inline variant hides its details behind a 'Why this signal?' trigger", () => {
    const html = render({ ...FULL, variant: "inline" })
    expect(html).toContain("Why this signal?")
    expect(render({ variant: "inline" })).toContain("bg-elevated")
    expect(render({ variant: "drawer" })).not.toContain("bg-elevated")
    expect(html).toContain("Asing mengakumulasi selama lima sesi.")
    expect(html).not.toContain("Kontribusi fitur")
  })

  test("the inline variant shows its details when opened", () => {
    const html = render({ ...FULL, defaultOpen: true })
    expect(html).toContain("Kontribusi fitur")
  })

  test("the drawer variant is always expanded and has no trigger", () => {
    const html = render({ ...FULL, variant: "drawer", open: false })
    expect(html).not.toContain("Why this signal?")
    expect(html).toContain("Kontribusi fitur")
  })

  test("lists inputs with their source and time when known", () => {
    const html = render({ ...FULL, variant: "drawer" })
    expect(html).toContain("Sumber input (observed data)")
    expect(html).toContain("Broker summary")
    expect(html).toMatch(/ — IDX · 14\.45 WIB/)
    expect(html).toMatch(/Harga penutupan<span[^>]*> — IDX<\/span>/)
    expect(html).toContain("<li>Volume harian</li>")
  })

  test("draws contributions as diverging bars clamped to ±1", () => {
    const html = render({ ...FULL, variant: "drawer" })
    expect(html).toContain('aria-label="Net beli asing mendukung 62%"')
    expect(html).toContain("+0,62")
    expect(html).toContain('aria-label="Volume melemahkan 100%"')
    expect(html).toContain("−1,00")
    expect(html).toContain("width:50%")
  })

  test("lists limitations and closes with the disclaimer and computed time", () => {
    const html = render({ ...FULL, variant: "drawer" })
    expect(html).toContain("Keterbatasan")
    expect(html).toContain("Tidak mencakup transaksi negosiasi")
    expect(html).toContain(AI_DISCLAIMER)
    expect(html).toMatch(/Dihitung 28 Okt.* 14\.45 WIB\./)
  })

  test("omits empty sections but keeps the disclaimer", () => {
    const html = render({ variant: "drawer" })
    expect(html).not.toContain("Sumber input")
    expect(html).not.toContain("Kontribusi fitur")
    expect(html).not.toContain("Keterbatasan")
    expect(html).not.toContain("Dihitung")
    expect(html).toContain(AI_DISCLAIMER)
  })
})
