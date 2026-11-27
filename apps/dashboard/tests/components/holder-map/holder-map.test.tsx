import { StockCode, WibDate } from "@workspace/relay"
import { describe, expect, test } from "vitest"

import { HolderMapPage } from "@/components/holder-map/holder-map"
import type { HolderMapView } from "@/lib/holder-map"

import { renderAt } from "../../support/render-at"

const landing: HolderMapView = {
  day: WibDate.make("2026-06-25"),
  month: WibDate.make("2026-04-30"),
  refused: undefined,
  days: [WibDate.make("2026-06-25"), WibDate.make("2026-11-20")],
  focus: undefined,
  mostHeld: [{ code: StockCode.make("FLMC"), issuerName: "FLMC", holders: 13 }],
}

const page = () => (
  <HolderMapPage
    map={landing}
    list={{ _tag: "Loading" }}
    onStock={() => undefined}
    onRefocus={() => undefined}
    onDay={() => undefined}
  />
)

const mostHeldHref = (html: string) =>
  /href="([^"]*stock=FLMC[^"]*)"/.exec(html)?.[1]?.replaceAll("&amp;", "&")

describe("HolderMapPage's stocks most held", () => {
  test("keep the day picked", async () => {
    const html = await renderAt("/holder-map?day=2026-06-25", page)
    expect(mostHeldHref(html)).toBe("/holder-map?day=2026-06-25&stock=FLMC")
  })

  test("open the newest day when none is picked", async () => {
    const html = await renderAt("/holder-map", page)
    expect(mostHeldHref(html)).toBe("/holder-map?stock=FLMC")
  })
})
