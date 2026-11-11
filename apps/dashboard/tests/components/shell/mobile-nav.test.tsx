import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { renderAt } from "../../support/render-at"
import { MobileNav } from "@/components/shell/mobile-nav"

describe("MobileNav", () => {
  it.effect("shows an admin the Accounts entry", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => (
        <MobileNav features={["market-live", "account", "admin"]} />
      ))
      expect(html).toMatch(/<a[^>]*href="\/admin\/users"[^>]*>.*Accounts/)
    })
  )

  it.effect("shows a member no Accounts entry", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => (
        <MobileNav features={["market-live", "account"]} />
      ))
      expect(html).not.toContain("/admin/users")
    })
  )
})
