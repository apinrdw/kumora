import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

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
  it.effect("shows an admin viewing as a member the banner with Stop", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => (
        <AppShell viewer={{ ...viewer, impersonating: true }}>page</AppShell>
      ))
      expect(text(html)).toContain("Viewing as ayu@example.com·Stop")
      expect(html).toMatch(/<button[^>]*>Stop<\/button>/)
    })
  )

  it.effect("shows no banner to the account itself", () =>
    Effect.gen(function* () {
      const html = yield* renderAt("/", () => (
        <AppShell viewer={viewer}>page</AppShell>
      ))
      expect(text(html)).not.toContain("Viewing as")
    })
  )
})
