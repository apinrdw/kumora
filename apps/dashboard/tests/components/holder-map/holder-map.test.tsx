import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"

import { HolderMapPage } from "@/components/holder-map/holder-map"
import { HolderKey } from "@/domain/holdings"
import { type HolderMapView, holderMapView } from "@/lib/holder-map"

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
    onRefocus={() => undefined}
    onDay={() => undefined}
    showOffList
    onShowOffList={() => undefined}
  />
)

const mostHeldHref = (html: string) =>
  /href="([^"]*stock=FLMC[^"]*)"/.exec(html)?.[1]?.replaceAll("&amp;", "&")

describe("HolderMapPage's stocks most held", () => {
  test("keep the day picked", async () => {
    const html = await renderAt("/holder-map?day=2026-06-25", page)
    expect(mostHeldHref(html)).toBe("/holder-map?stock=FLMC&day=2026-06-25")
  })

  test("open the newest day when none is picked", async () => {
    const html = await renderAt("/holder-map", page)
    expect(mostHeldHref(html)).toBe("/holder-map?stock=FLMC")
  })
})

// A holder that left its only stock: no bands' holdings, one Off list
// holding.
const leftEverything = Effect.runSync(
  holderMapView({
    day: WibDate.make("2026-11-20"),
    month: WibDate.make("2026-10-30"),
    refused: undefined,
    days: [WibDate.make("2026-11-20")],
    focus: { kind: "holder", key: HolderKey.make("DJONI"), name: "DJONI" },
    links: [],
    hops: [],
    custodians: [],
    issuers: [],
    offList: [
      {
        code: StockCode.make("TRUE"),
        band: "5%",
        holder: HolderKey.make("DJONI"),
        name: "DJONI",
        since: WibDate.make("2026-11-19"),
        percentageHundredths: 600,
      },
    ],
    offListCut: false,
    mostHeld: [],
  })
)

const leftPage = (showOffList: boolean) => () => (
  <HolderMapPage
    map={leftEverything}
    list={{ _tag: "Loading" }}
    onRefocus={() => undefined}
    onDay={() => undefined}
    showOffList={showOffList}
    onShowOffList={() => undefined}
  />
)

describe("HolderMapPage's focus with only Off list holdings", () => {
  test("draws the map while the Off list is shown", async () => {
    const html = await renderAt("/holder-map?holder=DJONI", leftPage(true))
    expect(html).toContain('id="holder-map-graph"')
    expect(html).toContain("No stocks held by DJONI")
  })

  test("draws no map while the Off list is hidden", async () => {
    const html = await renderAt(
      "/holder-map?holder=DJONI&offList=hide",
      leftPage(false)
    )
    expect(html).not.toContain('id="holder-map-graph"')
    expect(html).toContain("No stocks held by DJONI")
  })
})
