// @vitest-environment happy-dom
// The live table's speed test (spec apinrdw/kumora#113, "Dashboard bench";
// the prototype's bench on prototype/atom-seam-data-table). A 10% Day state
// update through the store must cost at most twice a plain memo-rows table
// (the prototype's variant G) re-rendered with the same rows. Both tables
// stay mounted and their ticks alternate, so a slow moment on the machine
// lands on both; each table's fastest of many ticks is compared. Both draw
// the watchlist's own cells, so they differ only in how a row gets its
// figures.
import { assert, it } from "@effect/vitest"
import { FrameScheduler, StockCode } from "@workspace/client"
import { manualFrames } from "@workspace/client/testing"
import type { DayState } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act, memo, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"

import {
  makeDayStateStore,
  type DayStateStore,
} from "@/components/market-live/day-state-store"
import { Watchlist, WatchlistCells } from "@/components/market-live/watchlist"
import { price } from "@/lib/format"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ROWS = 500
// Ticks timed on each table, after WARMUP untimed ones.
const TICKS = 60
const WARMUP = 10
// Decision: the store's path may cost up to twice the plain baseline: it
// adds the queue, the source fiber and the frame to the same row renders.
const LIMIT = 2

const CODES = Array.from({ length: ROWS }, (_, i) =>
  StockCode.make(`T${String(i).padStart(3, "0")}`)
)
const AS_OF = DateTime.makeUnsafe("2026-11-09T09:00:00+07:00")

const initialStates = (): Array<DayState> =>
  CODES.map((code, i) => {
    const last = 1_000 + ((i * 7919) % 9_000)
    return {
      code,
      last,
      change: { amount: 10, percent: ((i % 21) - 10) / 300 },
      open: last,
      high: last,
      low: last,
      volume: 100_000 * ((i % 31) + 1),
      value: last * 1e6 * ((i % 13) + 1),
      frequency: ROWS - i,
      asOf: AS_OF,
      provenance: "Stockbit",
    }
  })

// A price tick on exactly 10% of the codes, a different tenth each time.
const tick = (states: ReadonlyArray<DayState>, n: number) => {
  const moved = states.flatMap((state, i) =>
    (i + n) % 10 === 0
      ? [
          {
            ...state,
            last: state.last + 5,
            value: state.value + state.last * 1_000,
            volume: state.volume + 100,
          },
        ]
      : []
  )
  const byCode = new Map(moved.map((state) => [state.code, state]))
  return {
    moved,
    all: states.map((state) => byCode.get(state.code) ?? state),
  }
}

const median = (xs: ReadonlyArray<number>) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

const ignore = () => {}

// Variant G: plain memo rows keyed on the row object, the Day states as props.
const BaselineRow = memo(function BaselineRow({ state }: { state: DayState }) {
  return (
    <WatchlistCells
      code={state.code}
      state={state}
      indicative={undefined}
      onSelect={ignore}
      onRemove={ignore}
    />
  )
})

function Baseline({ states }: { states: ReadonlyArray<DayState> }) {
  return (
    <table>
      <tbody>
        {states.map((state) => (
          <BaselineRow key={state.code} state={state} />
        ))}
      </tbody>
    </table>
  )
}

// The watchlist under a parent that re-renders it on every store
// notification, as a table sorted by a live figure would: only the memo on
// its rows keeps each frame to the rows whose Day state changed.
function EveryNotification({ store }: { store: DayStateStore }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot)
  return (
    <Watchlist
      codes={CODES}
      list={{ _tag: "Loading" }}
      store={store}
      onAdd={ignore}
      onRemove={ignore}
      onSelect={ignore}
    />
  )
}

const mount = () => {
  const container = document.body.appendChild(document.createElement("div"))
  return { container, root: createRoot(container) }
}

// The last code's price as drawn after the ticks, and as it should read: a
// table that skipped the work would time well and draw stale figures.
const lastPrice = (container: HTMLElement, states: ReadonlyArray<DayState>) => {
  const last = states.at(-1)!
  return {
    drawn: container.querySelector(
      `tr[data-code="${last.code}"] td:nth-child(2)`
    )?.textContent,
    expected: Effect.runSync(price(last.last)),
  }
}

// An async act around `effect`, so React flushes the renders it schedules.
const inAct = (effect: Effect.Effect<void>) =>
  Effect.promise(() => act(() => Effect.runPromise(effect)))

// Lets the store's source fiber drain what was queued.
const settle = Effect.repeat(Effect.yieldNow, { times: 10 })

// Times `effect`, in milliseconds.
const timed = (effect: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const start = performance.now()
    yield* effect
    return performance.now() - start
  })

it.live(
  `a 10% Day state update through the store costs at most ${LIMIT}x plain memo rows, ${ROWS} rows x 6 columns`,
  () =>
    Effect.gen(function* () {
      // The plain table: each tick renders it with every row's Day state.
      const plain = mount()
      let plainStates = initialStates()
      const renderPlain = Effect.sync(() =>
        act(() => plain.root.render(<Baseline states={plainStates} />))
      )
      yield* renderPlain

      // The store's table: each tick's delta is queued, drained by the
      // source, and drawn at the next frame.
      const frames = yield* manualFrames
      const store = yield* makeDayStateStore().pipe(
        Effect.provideService(FrameScheduler, frames.scheduler)
      )
      const live = mount()
      let storeStates = initialStates()
      yield* inAct(
        Effect.sync(() => live.root.render(<EveryNotification store={store} />))
      )
      store.replace(storeStates)
      yield* settle
      yield* inAct(frames.step)

      const plainTick = (n: number) =>
        timed(
          Effect.suspend(() => {
            plainStates = tick(plainStates, n).all
            return renderPlain
          })
        )
      const storeTick = (n: number) =>
        timed(
          Effect.gen(function* () {
            const next = tick(storeStates, n)
            storeStates = next.all
            store.apply({
              _tag: "Delta",
              tape: [],
              candles: [],
              dayStates: next.moved,
            })
            yield* settle
            yield* inAct(frames.step)
          })
        )

      const plainMs: Array<number> = []
      const storeMs: Array<number> = []
      for (let n = 0; n < WARMUP + TICKS; n++) {
        // Alternate which goes first, so neither always runs on a warm cache.
        const [first, second] =
          n % 2 === 0
            ? [plainTick(n), storeTick(n)]
            : [storeTick(n), plainTick(n)]
        const a = yield* first
        const b = yield* second
        if (n < WARMUP) continue
        const [p, t] = n % 2 === 0 ? [a, b] : [b, a]
        plainMs.push(p)
        storeMs.push(t)
      }

      for (const [table, states] of [
        [plain.container, plainStates],
        [live.container, storeStates],
      ] as const) {
        const { drawn, expected } = lastPrice(table, states)
        assert.strictEqual(drawn, expected)
      }
      yield* inAct(Effect.sync(() => live.root.unmount()))
      act(() => plain.root.unmount())
      live.container.remove()
      plain.container.remove()

      // Each table's fastest tick: a slow moment on the machine only adds
      // time, so the minimum is the tick's own cost. Under a full suite on
      // two cores the medians drift towards the limit; the minima hold.
      const plainMin = Math.min(...plainMs)
      const storeMin = Math.min(...storeMs)
      const report = `10% tick, fastest of ${TICKS}: store ${storeMin.toFixed(2)} ms, plain memo rows ${plainMin.toFixed(2)} ms (${(storeMin / plainMin).toFixed(2)}x); medians ${median(storeMs).toFixed(2)} ms and ${median(plainMs).toFixed(2)} ms`
      console.log(report)
      assert.isAtMost(storeMin, LIMIT * plainMin, report)
    }),
  60_000
)
