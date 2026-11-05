import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { IsoDateTime } from "@/domain/time"

import { KSignalCard } from "@/components/k/signal-card"
import type { KSignalCardProps } from "@/components/k/signal-card"

const AS_OF = IsoDateTime.make("2026-10-28T07:45:00Z")

function render(props: Partial<KSignalCardProps> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <KSignalCard
        ticker="BBCA"
        signal="accumulation"
        freshness="eod"
        {...props}
      />
    </TooltipProvider>
  )
}

describe("KSignalCard", () => {
  test("names the card after the ticker and the signal verdict", () => {
    const html = render({ name: "Bank Central Asia" })
    expect(html).toContain('aria-label="BBCA — Indikasi akumulasi terdeteksi"')
    expect(html).toContain("Bank Central Asia")
    expect(html).toContain("EOD")
  })

  test("a stale card gets the warning border", () => {
    expect(render({ freshness: "stale" })).toContain("border-warning")
    expect(render()).not.toContain("border-warning")
  })

  test("shows the confidence meter with its score out of 100", () => {
    const html = render({ confidenceScore: 72 })
    expect(html).toContain("Keyakinan pola")
    expect(html).toContain("72/100")
    expect(html).toContain('aria-label="Keyakinan klasifikasi pola"')
  })

  test("hides the meter without a score, and for an insufficient verdict even with one", () => {
    expect(render()).not.toContain("Keyakinan pola")
    const insufficient = render({ signal: "insufficient", confidenceScore: 72 })
    expect(insufficient).not.toContain("Keyakinan pola")
    expect(insufficient).toContain("Data belum cukup")
    expect(insufficient).toContain("Model tidak memaksakan")
  })

  test("lists observed evidence with its provenance and the counter-evidence", () => {
    const html = render({
      evidence: [
        {
          label: "Net beli asing",
          value: "Rp1,2 T",
          source: "IDX",
          asOf: AS_OF,
        },
        { label: "Volume", value: "2,1x" },
      ],
      counterEvidence: ["Harga belum menembus resistance"],
    })
    expect(html).toContain("Observed data")
    expect(html).toContain('title="IDX · 14.45 WIB"')
    expect(html).toContain("Rp1,2 T")
    expect(html).toContain('title=""')
    expect(html).toContain("Bukti berlawanan")
    expect(html).toContain("Harga belum menembus resistance")
  })

  test("omits evidence groups that are empty", () => {
    const html = render()
    expect(html).not.toContain("Observed data")
    expect(html).not.toContain("Bukti berlawanan")
  })

  test("shows the model version and computed time, joined only when both exist", () => {
    const both = render({ modelVersion: "sm-flow 0.9.2", computedAt: AS_OF })
    expect(both).toContain("Model sm-flow 0.9.2")
    expect(both).toContain('<span aria-hidden="true">·</span>')
    expect(both).toContain("dihitung 14.45 WIB")

    const versionOnly = render({ modelVersion: "sm-flow 0.9.2" })
    expect(versionOnly).toContain("sm-flow 0.9.2")
    expect(versionOnly).not.toContain('<span aria-hidden="true">·</span>')

    const timeOnly = render({ computedAt: AS_OF })
    expect(timeOnly).toContain("dihitung")
    expect(timeOnly).not.toContain("Model ")
  })

  test("offers watchlist and alert actions only when their handlers are given, never buy or sell", () => {
    const none = render()
    expect(none).not.toContain("Tambah ke Watchlist")
    expect(none).not.toContain("Buat Alert")

    const watch = render({ onAddWatchlist: () => {} })
    expect(watch).toContain("Tambah ke Watchlist")
    expect(watch).not.toContain("Buat Alert")

    const alert = render({ onCreateAlert: () => {} })
    expect(alert).toContain("Buat Alert")
    expect(alert).not.toContain("Tambah ke Watchlist")
    expect(alert).not.toMatch(/\b(BUY|SELL|Beli|Jual)\b/)
  })
})
