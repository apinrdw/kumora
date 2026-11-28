import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"

import { HolderMapGraph } from "@/components/holder-map/holder-map-graph"
import { useMapViewport } from "@/components/holder-map/use-map-viewport"
import { HolderKey } from "@/domain/holdings"
import { holderMapView } from "@/lib/holder-map"
import { fitExtent, type Layout } from "@/lib/holder-map-layout"

import { renderAt } from "../../support/render-at"

// The layout the worker would give, set below: the focus at the centre,
// each other node further out to the right.
const mocks = vi.hoisted((): { layout: Layout } => ({
  layout: { positions: {} },
}))

vi.mock("@/components/holder-map/use-holder-map-layout", () => ({
  useHolderMapLayout: () => mocks.layout,
}))
vi.mock("@/components/holder-map/use-map-viewport", { spy: true })

afterEach(() => {
  vi.mocked(useMapViewport).mockClear()
})

// A holder with one stock held and one it left, on the Off list.
const focus = Effect.runSync(
  holderMapView({
    day: WibDate.make("2026-11-20"),
    month: WibDate.make("2026-10-30"),
    refused: undefined,
    days: [WibDate.make("2026-11-20")],
    focus: { kind: "holder", key: HolderKey.make("DJONI"), name: "DJONI" },
    links: [
      {
        code: StockCode.make("BSDE"),
        band: "1%",
        holder: HolderKey.make("DJONI"),
        name: "DJONI",
        percentageHundredths: 200,
        shares: 1_000,
        origin: "local",
        investorType: "ID",
        move: undefined,
        crossing: undefined,
        gap: false,
      },
    ],
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
).focus

const nodes = focus?.graph.nodes ?? []
mocks.layout = {
  positions: Object.fromEntries(
    nodes.map((node, at) => [node.id, { x: node.focus ? 0 : 100 * at, y: 0 }])
  ),
}

// The extent the graph last asked the viewport to fit.
const fittedExtent = () => vi.mocked(useMapViewport).mock.calls.at(-1)?.[1]

const render = (showOffList: boolean) =>
  renderAt(
    "/holder-map?holder=DJONI",
    () =>
      focus && (
        <HolderMapGraph
          focus={focus}
          showOffList={showOffList}
          onRefocus={() => undefined}
          searched={undefined}
          onClearSearched={() => undefined}
        />
      )
  )

describe("HolderMapGraph's fit to view", () => {
  test("fits the nodes shown, the Off list's left out while it is hidden", async () => {
    await render(false)
    expect(nodes.some(({ offList }) => offList)).toBe(true)
    expect(fittedExtent()).toEqual(
      Effect.runSync(
        fitExtent(
          mocks.layout,
          nodes.filter(({ offList }) => !offList)
        )
      )
    )
  })

  test("fits every node while the Off list is shown", async () => {
    await render(true)
    expect(fittedExtent()).toEqual(
      Effect.runSync(fitExtent(mocks.layout, nodes))
    )
  })
})
