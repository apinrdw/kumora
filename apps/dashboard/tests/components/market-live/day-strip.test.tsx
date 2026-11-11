// @vitest-environment happy-dom
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import type * as Client from "@workspace/client"
import { WibDate, type RecordedDay } from "@workspace/relay"
import { Effect } from "effect"
import { act, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it } from "@effect/vitest"
import { vi } from "vitest"

import { DayStrip } from "@/components/market-live/day-strip"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchDayStrip:
    vi.fn<(fresh?: boolean) => Effect.Effect<ReadonlyArray<RecordedDay>>>(),
}))

// Counted when the load runs, not when the strip builds it.
vi.mock("@workspace/client", (importOriginal) =>
  importOriginal<typeof Client>().then((actual) => ({
    ...actual,
    fetchDayStrip: (fresh = false) =>
      Effect.suspend(() => mocks.fetchDayStrip(fresh)),
  }))
)

const FRIDAY = WibDate.make("2026-11-06")
const MONDAY = WibDate.make("2026-11-09")

const row = (day: WibDate): RecordedDay => ({
  day,
  ihsg: { close: 8_000, change: 40, changePercent: 0.5 },
  trades: 1,
  gap: false,
})

// The loader's closed day, as the page hands it to the strip.
let closedDay: WibDate | undefined
const listeners = new Set<() => void>()
const setClosedDay = (day: WibDate | undefined) => {
  closedDay = day
  for (const listener of listeners) listener()
}

function Page() {
  const day = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => closedDay
  )
  return <DayStrip shown={undefined} closedDay={day} />
}

beforeEach(() => {
  vi.useFakeTimers()
  closedDay = undefined
})

afterEach(() => {
  vi.useRealTimers()
  mocks.fetchDayStrip.mockReset()
})

// An async act around `f`, so React flushes the work it schedules.
const inAct = (f: () => unknown) =>
  Effect.promise(() => act(() => Effect.runPromise(Effect.sync(f))))

const advance = (ms: number) =>
  Effect.promise(() => act(() => vi.advanceTimersByTimeAsync(ms)))

it.live(
  "the strip asks for the days again, fresh, a minute after the loader says the day sealed",
  () =>
    Effect.gen(function* () {
      // The browser's copy, until the seal; the Worker's answer after it.
      mocks.fetchDayStrip.mockImplementation((fresh) =>
        Effect.succeed(fresh ? [row(MONDAY), row(FRIDAY)] : [row(FRIDAY)])
      )
      const rootRoute = createRootRoute({
        component: () => (
          <>
            <Page />
            <Outlet />
          </>
        ),
      })
      const router = createRouter({
        routeTree: rootRoute,
        history: createMemoryHistory({ initialEntries: ["/"] }),
      })
      yield* Effect.promise(() => router.load())
      const container = document.body.appendChild(document.createElement("div"))
      const root = createRoot(container)
      yield* inAct(() => root.render(<RouterProvider router={router} />))
      const links = () =>
        [...container.querySelectorAll("a")].map((link) => link.textContent)
      expect(links()).toEqual(["Today · live", "Fri, Nov 6IHSG +0.50%"])
      expect(mocks.fetchDayStrip.mock.calls).toEqual([[false]])

      // 17:00: the loader turns to the recorded view of today.
      yield* inAct(() => setClosedDay(MONDAY))
      yield* advance(59_000)
      expect(mocks.fetchDayStrip.mock.calls).toEqual([[false]])
      yield* advance(1_000)
      expect(mocks.fetchDayStrip.mock.calls).toEqual([[false], [true]])
      expect(links()).toEqual([
        "Today · live",
        "Mon, Nov 9IHSG +0.50%",
        "Fri, Nov 6IHSG +0.50%",
      ])

      // Midnight and 08:40 change the loader's answer, not the days recorded.
      yield* inAct(() => setClosedDay(undefined))
      yield* advance(60_000)
      expect(mocks.fetchDayStrip.mock.calls).toEqual([[false], [true]])
      yield* inAct(() => root.unmount())
    })
)
