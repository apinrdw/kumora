import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { AppSidebar } from "@/components/shell/app-sidebar"

/** The opening `<a>` tag of the sidebar entry titled `label`. */
async function linkAt(url: string, label: string) {
  const html = await renderAt(url, () => <AppSidebar />)
  const tag = html.match(new RegExp(`<a title="${label}"[^>]*>`))?.[0]
  if (!tag) throw new Error(`no sidebar link titled ${label}`)
  return tag
}

/** The markup of the sidebar entry titled `label`, up to its closing tag. */
async function entryAt(url: string, label: string) {
  const html = await renderAt(url, () => <AppSidebar />)
  const start = html.indexOf(`<a title="${label}"`)
  return html.slice(start, html.indexOf("</a>", start))
}

const isCurrent = (tag: string) => tag.includes('aria-current="page"')

describe("AppSidebar entries", () => {
  test("lists only Whale Radar and Whale Radar Live", async () => {
    const html = await renderAt("/radar", () => <AppSidebar />)
    const titles = [...html.matchAll(/<a title="([^"]+)"/g)].map((m) => m[1])
    expect(titles).toEqual(["Whale Radar", "Whale Radar Live"])
  })

  test("the entry for the current screen is the current page", async () => {
    expect(isCurrent(await linkAt("/radar", "Whale Radar"))).toBe(true)
    expect(isCurrent(await linkAt("/radar", "Whale Radar Live"))).toBe(false)
  })

  test("Whale Radar is not current on the live page below it", async () => {
    expect(isCurrent(await linkAt("/radar/live", "Whale Radar Live"))).toBe(
      true
    )
    expect(isCurrent(await linkAt("/radar/live", "Whale Radar"))).toBe(false)
  })

  test("the brand links straight to Whale Radar", async () => {
    const html = await renderAt("/radar", () => <AppSidebar />)
    expect(html).toMatch(/<a[^>]*href="\/radar"[^>]*><img/)
  })

  test("Whale Radar carries its Demo pill", async () => {
    expect(await entryAt("/radar", "Whale Radar")).toMatch(/>Demo<\/span>/)
  })
})
