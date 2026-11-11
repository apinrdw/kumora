import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { MobileNav } from "@/components/shell/mobile-nav"

describe("MobileNav", () => {
  test("shows an admin the Accounts entry", async () => {
    const html = await renderAt("/", () => (
      <MobileNav features={["market-live", "account", "admin"]} />
    ))
    expect(html).toMatch(/<a[^>]*href="\/admin\/users"[^>]*>.*Accounts/)
  })

  test("shows a member no Accounts entry", async () => {
    const html = await renderAt("/", () => (
      <MobileNav features={["market-live", "account"]} />
    ))
    expect(html).not.toContain("/admin/users")
  })
})
