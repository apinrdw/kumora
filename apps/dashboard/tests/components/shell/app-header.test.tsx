import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { AppHeader } from "@/components/shell/app-header"
import { MARKET_OVERVIEW } from "@/lib/market"

describe("AppHeader", () => {
  test("shows IHSG and net foreign from the root loader's overview", async () => {
    const html = await renderAt("/radar", () => <AppHeader />)
    expect(html).toContain(">7.243,18<")
    expect(html).toContain(">+0,42%<")
    expect(html).toContain(">+Rp534 M<")
  })

  test("follows the overview the root loader serves", async () => {
    const overview = {
      ...MARKET_OVERVIEW,
      ihsg: { last: 7001.5, changePct: -1.25 },
    }
    const html = await renderAt("/", () => <AppHeader />, { overview })
    expect(html).toContain(">7.001,50<")
    expect(html).toContain(">−1,25%<")
  })
})
