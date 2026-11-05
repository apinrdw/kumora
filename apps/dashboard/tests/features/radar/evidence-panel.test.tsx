import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { CANDIDATES, RADAR_SNAPSHOT } from "@/features/radar/data"
import { EvidencePanel } from "@/features/radar/evidence-panel"
import type { Candidate } from "@/features/radar/schema"

const ANTM = CANDIDATES.find((c) => c.symbol === "ANTM") as Candidate

const render = (candidate: Candidate | undefined) =>
  renderAt("/radar", () => (
    <EvidencePanel snapshot={RADAR_SNAPSHOT} candidate={candidate} />
  ))

describe("EvidencePanel", () => {
  test("asks for a pick when no candidate is selected", async () => {
    const html = await render(undefined)
    expect(html).toContain("Pilih kandidat")
    expect(html).not.toContain("Buka detail")
  })

  test("shows the candidate's signal and opens it on Whale Radar Live", async () => {
    const html = await render(ANTM)
    expect(html).toContain('aria-label="ANTM — ')
    expect(html).toContain('href="/radar/live?s=ANTM"')
    expect(html).toContain("ANTM · 20 sesi")
  })

  test("offers no alert or watchlist actions", async () => {
    const html = await render(ANTM)
    expect(html).not.toContain("/alerts")
    expect(html).not.toContain("Watchlist")
    expect(html).not.toContain("Buat Alert")
  })
})
