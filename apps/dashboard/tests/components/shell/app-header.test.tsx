import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { AppHeader } from "@/components/shell/app-header"

const viewer = {
  name: "Ayu Lestari",
  email: "ayu@example.com",
  features: ["market-live", "account"],
  impersonating: false,
} as const

describe("AppHeader", () => {
  test("the mobile logo links home", async () => {
    const html = await renderAt("/", () => <AppHeader viewer={viewer} />)
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*><img[^>]*alt="KUMORA AI"/)
  })

  test("shows the WIB clock and no market tickers or search", async () => {
    const html = await renderAt("/", () => <AppHeader viewer={viewer} />)
    expect(html).toContain(">WIB<")
    expect(html).not.toContain("IHSG")
    expect(html).not.toContain('role="search"')
  })
})
