// @vitest-environment happy-dom
// The watchlist on @workspace/client's Day state store: which rows an update
// re-renders, what the server renders, and the sort.
import { describe, expect, it } from "@effect/vitest"
import { FrameScheduler } from "@workspace/client"
import { manualFrames } from "@workspace/client/testing"
import { StockCode, type DayState } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { vi } from "vitest"

import { makeDayStateStore } from "@/components/market-live/day-state-store"
import { Watchlist } from "@/components/market-live/watchlist"
import type { WatchlistSort } from "@/components/market-live/watchlist-sort"
import type * as Format from "@/lib/format"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Each row with a Day state formats its last price once a render, so the
// prices formatted say which rows rendered.
const priced = vi.hoisted((): Array<number> => [])
vi.mock("@/lib/format", (importOriginal) =>
  importOriginal<typeof Format>().then((actual) => ({
    ...actual,
    price: (n: number) => {
      priced.push(n)
      return actual.price(n)
    },
  }))
)

const BBCA = StockCode.make("BBCA")
const TLKM = StockCode.make("TLKM")
const ASII = StockCode.make("ASII")
const CODES = [BBCA, TLKM, ASII]

const stateOf = (
  code: StockCode,
  last: number,
  value: number,
  percent = 0.5
): DayState => ({
  code,
  last,
  change: { amount: 10, percent },
  open: last,
  high: last,
  low: last,
  volume: 1_000,
  value,
  frequency: 10,
  asOf: DateTime.makeUnsafe("2026-11-09T09:00:00+07:00"),
  provenance: "Stockbit",
})

const INITIAL = [
  stateOf(BBCA, 9_800, 3_000),
  stateOf(TLKM, 3_100, 2_000),
  stateOf(ASII, 5_000, 1_000),
]

// Lets the store's source fiber drain what the test queued.
const settle = Effect.repeat(Effect.yieldNow, { times: 10 })

// An async act around `effect`, so React flushes the renders it schedules.
const inAct = (effect: Effect.Effect<void>) =>
  Effect.promise(() => act(() => Effect.runPromise(effect)))

// The watchlist over a store whose frames the test steps.
const mounted = (
  sort?: WatchlistSort,
  onSort?: (sort?: WatchlistSort) => void
) =>
  Effect.gen(function* () {
    const frames = yield* manualFrames
    const store = yield* makeDayStateStore(INITIAL).pipe(
      Effect.provideService(FrameScheduler, frames.scheduler)
    )
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    yield* inAct(
      Effect.sync(() =>
        root.render(
          <Watchlist
            codes={CODES}
            list={{ _tag: "Loading" }}
            store={store}
            sort={sort}
            onSort={onSort}
            onAdd={() => {}}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        )
      )
    )
    // One update through the store, shown at the next frame.
    const update = (states: ReadonlyArray<DayState>) =>
      Effect.gen(function* () {
        priced.length = 0
        store.apply({ _tag: "Delta", tape: [], candles: [], dayStates: states })
        yield* settle
        yield* inAct(frames.step)
      })
    const order = () =>
      [...container.querySelectorAll("tbody tr")].map((row) =>
        row.getAttribute("data-code")
      )
    const unmount = inAct(Effect.sync(() => root.unmount()))
    return { container, update, order, unmount }
  })

describe("the watchlist on the Day state store", () => {
  it.effect("updating one stock code re-renders only that row", () =>
    Effect.gen(function* () {
      const { container, update, unmount } = yield* mounted()
      yield* update([stateOf(BBCA, 9_825, 3_000)])
      expect(priced).toEqual([9_825])
      expect(
        container.querySelector('tr[data-code="BBCA"]')?.textContent
      ).toContain("9,825")
      yield* unmount
    })
  )

  it.effect(
    "sorted by a Day state figure, the table re-sorts and still re-renders only the updated row",
    () =>
      Effect.gen(function* () {
        const { update, order, unmount } = yield* mounted({
          key: "value",
          dir: "desc",
        })
        expect(order()).toEqual(["BBCA", "TLKM", "ASII"])
        yield* update([stateOf(ASII, 5_050, 4_000)])
        expect(priced).toEqual([5_050])
        expect(order()).toEqual(["ASII", "BBCA", "TLKM"])
        yield* unmount
      })
  )

  it.effect("a header click cycles its column's sort", () =>
    Effect.gen(function* () {
      const sorts: Array<WatchlistSort | undefined> = []
      const { container, unmount } = yield* mounted(
        { key: "change", dir: "desc" },
        (sort) => sorts.push(sort)
      )
      const header = (label: string) =>
        [...container.querySelectorAll("th button")].find(
          (button) => button.textContent === label
        ) as HTMLButtonElement
      expect(
        container.querySelector('th[aria-sort="descending"]')?.textContent
      ).toBe("Change")
      yield* inAct(Effect.sync(() => header("Change").click()))
      yield* inAct(Effect.sync(() => header("Value").click()))
      yield* inAct(Effect.sync(() => header("Code").click()))
      expect(sorts).toEqual([
        { key: "change", dir: "asc" },
        { key: "value", dir: "desc" },
        { key: "code", dir: "asc" },
      ])
      yield* unmount
    })
  )

  it.effect(
    "the server render shows the loader's Day state, and the source never starts",
    () =>
      Effect.gen(function* () {
        const frames = yield* manualFrames
        const store = yield* makeDayStateStore(INITIAL).pipe(
          Effect.provideService(FrameScheduler, frames.scheduler)
        )
        // Queued before the render: only a started source would apply it.
        store.apply({
          _tag: "Delta",
          tape: [],
          candles: [],
          dayStates: [stateOf(BBCA, 9_900, 3_000)],
        })
        const html = renderToString(
          <Watchlist
            codes={[BBCA]}
            list={{ _tag: "Loading" }}
            store={store}
            onAdd={() => {}}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        )
        yield* settle
        expect(html).toContain("9,800")
        expect(html).not.toContain("9,900")
        expect(store.getSnapshot().get(BBCA)?.last).toBe(9_800)
      })
  )
})
