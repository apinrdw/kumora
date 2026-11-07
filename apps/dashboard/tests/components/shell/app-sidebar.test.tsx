import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { AppSidebar } from "@/components/shell/app-sidebar"

const viewer = {
  name: "Ayu Lestari",
  email: "ayu@example.com",
  features: ["market-live", "account"],
  impersonating: false,
} as const

describe("AppSidebar", () => {
  test("hides the Admin group from a member", async () => {
    const html = await renderAt("/", () => <AppSidebar viewer={viewer} />)
    expect(html.match(/<a title="/g)).toBeNull()
    expect(html).not.toContain(">Admin<")
  })

  test("shows an admin the Admin group", async () => {
    const admin = {
      ...viewer,
      features: [...viewer.features, "admin"],
    } as const
    const html = await renderAt("/", () => <AppSidebar viewer={admin} />)
    expect(html).toContain(">Admin<")
    expect(html).toMatch(/<a title="Accounts"[^>]*href="\/admin\/users"/)
  })

  test("the brand links home", async () => {
    const html = await renderAt("/", () => <AppSidebar viewer={viewer} />)
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*><img/)
  })

  test("the user menu shows the signed-in account", async () => {
    const html = await renderAt("/", () => <AppSidebar viewer={viewer} />)
    expect(html).toContain("Ayu Lestari")
    expect(html).toContain("ayu@example.com")
    expect(html).toContain(">AL<")
  })
})
