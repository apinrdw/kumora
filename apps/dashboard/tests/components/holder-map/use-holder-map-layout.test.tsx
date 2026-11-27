// @vitest-environment happy-dom
import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import type { LayoutRequest } from "@/components/holder-map/layout.worker"
import { useHolderMapLayout } from "@/components/holder-map/use-holder-map-layout"
import { HolderKey } from "@/domain/holdings"
import { holderMapView } from "@/lib/holder-map"
import type { Layout } from "@/lib/holder-map-layout"
import type {
  HolderMapLink,
  HolderMapRead,
} from "@/server/holdings/holder-map-schema"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// A layout worker that answers each request with every node it was asked
// for, at the origin.
const requests: Array<LayoutRequest> = []
class FakeWorker extends EventTarget {
  postMessage(request: LayoutRequest) {
    requests.push(request)
    const layout: Layout = {
      positions: Object.fromEntries(
        request.graph.nodes.map(({ id }) => [id, { x: 0, y: 0 }])
      ),
      extent: { x: [0, 0], y: [0, 0] },
    }
    setTimeout(() =>
      this.dispatchEvent(
        new MessageEvent("message", { data: { id: request.id, layout } })
      )
    )
  }
  terminate() {}
}
vi.stubGlobal("Worker", FakeWorker)

afterEach(() => {
  requests.length = 0
})

const link = (name: string): HolderMapLink => ({
  code: StockCode.make("TRUE"),
  band: "5%",
  holder: HolderKey.make(name),
  name,
  percentageHundredths: 900,
  shares: 900_000,
  origin: "local",
  investorType: "CP",
  move: undefined,
  gap: false,
  crossing: undefined,
})

// TRUE's map on 20 Nov with `names` as its holders.
const graphOf = (names: ReadonlyArray<string>) => {
  const view = Effect.runSync(
    holderMapView({
      day: WibDate.make("2026-11-20"),
      month: WibDate.make("2026-10-30"),
      refused: undefined,
      days: [WibDate.make("2026-11-20")],
      focus: {
        kind: "stock",
        code: StockCode.make("TRUE"),
        issuerName: "TRUE",
      },
      links: names.map(link),
      hops: [],
      custodians: [],
      issuers: [],
      offList: [],
      offListCut: false,
      mostHeld: [],
    } satisfies HolderMapRead)
  )
  const graph = view.focus?.graph
  if (graph === undefined) throw new Error("no focus")
  return graph
}

type Graph = ReturnType<typeof graphOf>

test("lays out again a graph of the same focus and day with new nodes, not an equivalent one", async () => {
  const seen: Array<Layout | undefined> = []
  const Probe = ({ graph }: { graph: Graph }) => {
    seen.push(useHolderMapLayout(graph))
    return null
  }
  const root = createRoot(document.createElement("div"))
  const settle = () =>
    act(() => new Promise((settled) => setTimeout(settled, 20)))
  const placed = () => Object.keys(seen.at(-1)?.positions ?? {}).length
  act(() => root.render(<Probe graph={graphOf(["A"])} />))
  await settle()
  expect(placed()).toBe(2)
  // A revalidation of the same focus and day that gained a holder.
  act(() => root.render(<Probe graph={graphOf(["A", "B"])} />))
  await settle()
  expect(requests).toHaveLength(2)
  expect(placed()).toBe(3)
  // A reload of the same graph keeps its layout.
  act(() => root.render(<Probe graph={graphOf(["A", "B"])} />))
  await settle()
  expect(requests).toHaveLength(2)
  expect(placed()).toBe(3)
  act(() => root.unmount())
})
