import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { AppShell } from "@/components/shell/app-shell"

const viewer = {
  name: "Ayu Lestari",
  email: "ayu@example.com",
  features: ["market-live", "account"],
  impersonating: false,
} as const

const text = (html: string) => html.replace(/<[^>]+>/g, "")

describe("AppShell", () => {
  test("shows an admin viewing as a member the banner with Stop", async () => {
    const html = await renderAt("/", () => (
      <AppShell viewer={{ ...viewer, impersonating: true }}>page</AppShell>
    ))
    expect(text(html)).toContain("Viewing as ayu@example.com·Stop")
    expect(html).toMatch(/<button[^>]*>Stop<\/button>/)
  })

  test("shows no banner to the account itself", async () => {
    const html = await renderAt("/", () => (
      <AppShell viewer={viewer}>page</AppShell>
    ))
    expect(text(html)).not.toContain("Viewing as")
  })
})
