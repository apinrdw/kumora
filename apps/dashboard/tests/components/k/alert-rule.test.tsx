import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { KAlertRule } from "@/components/k/alert-rule"
import type { KAlertRuleProps } from "@/components/k/alert-rule"
import type { AlertRule } from "@/domain/alert"

const RULE: AlertRule = {
  indicator: "volume_vs_avg",
  operator: "gte",
  threshold: "2,0",
  scope: "BBCA",
  session: "session1",
  channel: "email",
  cooldownMin: 30,
}

const noop = () => {}

function display(
  props: Partial<Extract<KAlertRuleProps, { mode: "display" }>> = {}
) {
  return renderToStaticMarkup(
    <KAlertRule
      mode="display"
      rule={RULE}
      enabled
      onEnabledChange={noop}
      {...props}
    />
  )
}

function builder(
  props: Partial<Extract<KAlertRuleProps, { mode: "builder" }>> = {}
) {
  return renderToStaticMarkup(
    <KAlertRule
      mode="builder"
      rule={RULE}
      onChange={noop}
      onSave={noop}
      onCancel={noop}
      {...props}
    />
  )
}

describe("KAlertRule display mode", () => {
  test("reads the rule as a sentence of labelled tokens", () => {
    const html = display()
    expect(html).toContain("Volume vs rata-rata 20 hari")
    expect(html).toContain("≥ 2,0")
    expect(html).toContain(">BBCA</code>")
    expect(html).toContain(">Sesi 1</code>")
    expect(html).toContain(">email</code>")
    expect(html).toContain("Cooldown 30 mnt")
  })

  test("an empty scope shows a dash", () => {
    expect(display({ rule: { ...RULE, scope: "" } })).toContain(">—</code>")
  })

  test("shows when it last fired, or that it never has", () => {
    expect(display()).toContain("Belum pernah terpicu")
    expect(display({ lastFired: "2026-10-28T07:45:00Z" })).toMatch(
      /Terakhir terpicu 28 Okt.* 14\.45 WIB/
    )
  })

  test("an enabled rule offers to disable itself; a disabled one is dimmed and offers to enable", () => {
    const on = display()
    expect(on).toContain('aria-label="Nonaktifkan aturan"')
    expect(on).not.toContain("aria-disabled")
    expect(on).not.toContain("opacity-70")

    const off = display({ enabled: false })
    expect(off).toContain('aria-label="Aktifkan aturan"')
    expect(off).toContain('aria-disabled="true"')
    expect(off).toContain("opacity-70")
  })

  test("the edit button appears only with onEdit", () => {
    expect(display()).not.toContain("Ubah aturan")
    expect(display({ onEdit: noop })).toContain('aria-label="Ubah aturan"')
  })

  test("names the feed it depends on, info-toned for EOD and warning otherwise", () => {
    expect(display()).not.toContain("Feed ")
    const eod = display({ feedDependency: "eod" })
    expect(eod).toContain("Feed EOD")
    expect(eod).toContain("text-info")
    const live = display({ feedDependency: "live" })
    expect(live).toContain("Feed LIVE")
    expect(live).toContain("text-warning")
  })
})

describe("KAlertRule builder mode", () => {
  test("lays the editable rule out as a labelled sentence with every field", () => {
    const html = builder()
    expect(html).toContain('aria-label="Aturan alert"')
    for (const label of [
      "Indikator",
      "Operator",
      "Ambang",
      "Ticker atau watchlist",
      "Sesi",
      "Saluran",
    ]) {
      expect(html).toContain(label)
    }
    expect(html).toContain('value="2,0"')
    expect(html).toContain('value="BBCA"')
    expect(html).toContain("Cooldown 30 menit · tidak ada notifikasi ganda")
    expect(html).toContain("Batal")
    expect(html).toContain("Simpan aturan")
  })

  test("phrases the feed badge for the builder", () => {
    expect(builder({ feedDependency: "delayed" })).toContain(
      "Bergantung pada feed DELAYED"
    )
  })

  test("does not show display-only controls", () => {
    const html = builder()
    expect(html).not.toContain("terpicu")
    expect(html).not.toContain("Nonaktifkan aturan")
  })
})
