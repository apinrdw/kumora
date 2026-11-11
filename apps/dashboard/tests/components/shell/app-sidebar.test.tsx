import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { renderAt } from "../../support/render-at"
import { AppSidebar } from "@/components/shell/app-sidebar"

const viewer = {
  name: "Ayu Lestari",
  email: "ayu@example.com",
  features: ["market-live", "account"],
  impersonating: false,
} as const

describe("AppSidebar", () => {
  it.effect("shows a member the Market group, without Admin", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => <AppSidebar viewer={viewer} />)
      expect(html).toContain(">Market<")
      expect(html).toMatch(/<a title="Market Live"[^>]*href="\/market-live"/)
      expect(html).not.toContain(">Admin<")
      expect(html).not.toContain('title="Accounts"')
    })
  )

  it.effect("shows an admin the Admin group", () =>
    Effect.gen(function* () {
      const admin = {
        ...viewer,
        features: [...viewer.features, "admin"],
      } as const
      const html = yield* renderAt("/", () => <AppSidebar viewer={admin} />)
      expect(html).toContain(">Admin<")
      expect(html).toMatch(/<a title="Accounts"[^>]*href="\/admin\/users"/)
    })
  )

  it.effect("the brand links home", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => <AppSidebar viewer={viewer} />)
      expect(html).toMatch(/<a[^>]*href="\/"[^>]*><img/)
    })
  )

  it.effect("the user menu shows the signed-in account", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => <AppSidebar viewer={viewer} />)
      expect(html).toContain("Ayu Lestari")
      expect(html).toContain("ayu@example.com")
      expect(html).toContain(">AL<")
    })
  )
})
