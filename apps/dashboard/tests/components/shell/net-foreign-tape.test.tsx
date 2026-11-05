import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { NetForeignTape } from "@/components/shell/net-foreign-tape"
import { MARKET_OVERVIEW } from "@/lib/market"
import { Symbol } from "@/domain/symbol"

describe("NetForeignTape", () => {
  test("lists every Symbol of the overview's tape twice for the loop", async () => {
    const html = await renderAt("/", () => <NetForeignTape />)
    expect(html.match(/<b[^>]*>BBRI<\/b>/g)).toHaveLength(2)
    expect(html.match(/<b[^>]*>GOTO<\/b>/g)).toHaveLength(2)
  })

  test("follows the overview the root loader serves", async () => {
    const overview = {
      ...MARKET_OVERVIEW,
      netForeignTape: [[Symbol.make("BMRI"), -120]] as const,
    }
    const html = await renderAt("/", () => <NetForeignTape />, { overview })
    expect(html).toContain(">BMRI</b>")
    expect(html).not.toContain(">BBRI</b>")
    expect(html).toMatch(/class="text-down">−Rp120 M</)
  })
})
