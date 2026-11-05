import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { AppSidebar } from "@/components/shell/app-sidebar"

describe("AppSidebar", () => {
  test("lists no entries while NAV is empty", async () => {
    const html = await renderAt("/", () => <AppSidebar />)
    expect(html.match(/<a title="/g)).toBeNull()
  })

  test("the brand links home", async () => {
    const html = await renderAt("/", () => <AppSidebar />)
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*><img/)
  })
})
