// @vitest-environment happy-dom
// The Holder map route's own wiring, its read and search list faked: the
// loader's redirect of a holder focus the read took under another key, and
// the search list's day.
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { WibDate } from "@workspace/relay"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { HolderKey, type HolderMapQuery } from "@/domain/holdings"
import { Route } from "@/routes/_app/holder-map"
import type { HolderMapRead } from "@/server/holdings/holder-map-schema"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  read: vi.fn<(request: { data: HolderMapQuery }) => Promise<unknown>>(),
  list: vi.fn<(request: { data: { day?: string } }) => Promise<unknown>>(),
}))

vi.mock("@/server/stocks/stocks.functions", () => ({
  holderMapFn: (request: { data: HolderMapQuery }) => mocks.read(request),
  holderMapSearchListFn: (request: { data: { day?: string } }) =>
    mocks.list(request),
}))
// The page itself has its own tests.
vi.mock("@/components/holder-map/holder-map", () => ({
  HolderMapPage: () => null,
}))

afterEach(() => {
  mocks.read.mockReset()
  mocks.list.mockReset()
})

const DAY = WibDate.make("2026-11-20")
const MANUNGGAL = HolderKey.make("DEVELOPMENT MANUNGGAL PRIME")
const ALIAS = HolderKey.make("DEVELOPMENT HOLDINGS LTD MANUNGGAL PRIME")

// The read of a holder focus on `key` as of DAY, holding nothing.
const holderRead = (key: HolderKey): HolderMapRead => ({
  day: DAY,
  refused: undefined,
  days: [DAY],
  month: WibDate.make("2026-10-30"),
  focus: { kind: "holder", key, name: undefined },
  links: [],
  hops: [],
  custodians: [],
  issuers: [],
  offList: [],
  offListCut: false,
  mostHeld: [],
})

// The route under the app's pathless layout, as routeTree.gen.ts nests it,
// opened at `url`.
async function open(url: string) {
  const root = createRootRoute({ component: Outlet })
  const app = createRoute({
    getParentRoute: () => root,
    id: "_app",
    component: Outlet,
  })
  const holderMap = Route.update({
    id: "/holder-map",
    path: "/holder-map",
    getParentRoute: () => app,
  } as Parameters<typeof Route.update>[0])
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([holderMap])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const dom = createRoot(document.createElement("div"))
  await act(() => router.load())
  await act(async () => dom.render(<RouterProvider router={router} />))
  // The search list's load and the runtime's fiber settle.
  await act(() => new Promise((settled) => setTimeout(settled, 50)))
  return { router, close: () => act(() => dom.unmount()) }
}

test("opens a holder focus the read took under another key on that key, in place", async () => {
  // ASRI's later Manunggal blocks repeat its first under another name: the
  // read of that name's key is Manunggal's.
  mocks.read.mockImplementation(() => Promise.resolve(holderRead(MANUNGGAL)))
  mocks.list.mockResolvedValue({ stocks: [], holders: [], custodians: [] })
  const { router, close } = await open(
    `/holder-map?holder=${encodeURIComponent(ALIAS)}`
  )
  expect(router.state.location.search).toEqual({ holder: MANUNGGAL })
  expect(
    mocks.read.mock.calls.map(([{ data }]) =>
      data.focus?.kind === "holder" ? data.focus.key : undefined
    )
  ).toEqual([ALIAS, MANUNGGAL])
  expect(router.history.length).toBe(1)
  close()
})

test("loads the search list as of the day the map was read as of when no day is asked", async () => {
  mocks.read.mockImplementation(() => Promise.resolve(holderRead(MANUNGGAL)))
  mocks.list.mockResolvedValue({ stocks: [], holders: [], custodians: [] })
  const { close } = await open(
    `/holder-map?holder=${encodeURIComponent(MANUNGGAL)}`
  )
  expect(mocks.list.mock.calls.map(([{ data }]) => data.day)).toEqual([DAY])
  close()
})
