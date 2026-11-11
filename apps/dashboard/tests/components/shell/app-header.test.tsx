import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { renderAt } from "../../support/render-at"
import { AppHeader } from "@/components/shell/app-header"

const viewer = {
  name: "Ayu Lestari",
  email: "ayu@example.com",
  features: ["market-live", "account"],
  impersonating: false,
} as const

describe("AppHeader", () => {
  it.effect("the mobile logo links home", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => <AppHeader viewer={viewer} />)
      expect(html).toMatch(/<a[^>]*href="\/"[^>]*><img[^>]*alt="KUMORA AI"/)
    })
  )

  it.effect("shows the WIB clock and no market tickers or search", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => <AppHeader viewer={viewer} />)
      expect(html).toContain(">WIB<")
      expect(html).not.toContain("IHSG")
      expect(html).not.toContain('role="search"')
    })
  )
})
