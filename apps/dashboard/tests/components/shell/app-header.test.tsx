import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { AppHeader } from "@/components/shell/app-header"

describe("AppHeader", () => {
  test("the mobile logo links home", async () => {
    const html = await renderAt("/", () => <AppHeader />)
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*><img[^>]*alt="KUMORA AI"/)
  })

  test("shows the WIB clock and no market tickers or search", async () => {
    const html = await renderAt("/", () => <AppHeader />)
    expect(html).toContain(">WIB<")
    expect(html).not.toContain("IHSG")
    expect(html).not.toContain('role="search"')
  })
})
