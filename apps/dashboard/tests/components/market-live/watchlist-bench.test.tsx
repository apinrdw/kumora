// @vitest-environment happy-dom
// The live table's speed test (spec apinrdw/kumora#113, "Dashboard bench";
// the prototype's bench on prototype/atom-seam-data-table). A 10% Day state
// update through the store must cost at most twice a plain memo-rows table
// (the prototype's variant G) re-rendered with the same rows, measured in
// the same run so the machine's speed cancels out. Both draw the
// watchlist's own cells, so they differ only in how a row gets its figures.
import { assert, it } from "@effect/vitest"
import { FrameScheduler, StockCode } from "@workspace/client"
import { manualFrames } from "@workspace/client/testing"
import type { DayState } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act, memo } from "react"
import { createRoot } from "react-dom/client"

import { makeDayStateStore } from "@/components/market-live/day-state-store"
import { Watchlist, WatchlistCells } from "@/components/market-live/watchlist"
import { price } from "@/lib/format"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ROWS = 500
const TICKS = 15
const ROUNDS = 3
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
      // Distinct, and never moved by a tick: sorted by it, the order holds,
      // so the test times the row path rather than DOM moves.
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

// The median time of a 10% tick re-rendering the plain table.
const baseline = Effect.sync(() => {
  const { container, root } = mount()
  let states = initialStates()
  act(() => root.render(<Baseline states={states} />))
  const times: Array<number> = []
  for (let n = 0; n < TICKS; n++) {
    states = tick(states, n).all
    const start = performance.now()
    act(() => root.render(<Baseline states={states} />))
    times.push(performance.now() - start)
  }
  const drawn = lastPrice(container, states)
  act(() => root.unmount())
  container.remove()
  return { ms: median(times), ...drawn }
})

// An async act around `effect`, so React flushes the renders it schedules.
const inAct = (effect: Effect.Effect<void>) =>
  Effect.promise(() => act(() => Effect.runPromise(effect)))

// Lets the store's source fiber drain what was queued.
const settle = Effect.repeat(Effect.yieldNow, { times: 10 })

// The median time of a 10% tick through the store to the watchlist's DOM:
// the delta queued, drained by the source, and drawn at the next frame. The
// watchlist is sorted by a Day state figure, so each frame re-renders the
// table as well as the moved rows.
const throughStore = Effect.gen(function* () {
  const frames = yield* manualFrames
  let states = initialStates()
  const store = yield* makeDayStateStore(states).pipe(
    Effect.provideService(FrameScheduler, frames.scheduler)
  )
  const { container, root } = mount()
  yield* inAct(
    Effect.sync(() =>
      root.render(
        <Watchlist
          codes={CODES}
          list={{ _tag: "Loading" }}
          store={store}
          sort={{ key: "frequency", dir: "desc" }}
          onAdd={ignore}
          onRemove={ignore}
          onSelect={ignore}
        />
      )
    )
  )
  const times: Array<number> = []
  for (let n = 0; n < TICKS; n++) {
    const next = tick(states, n)
    states = next.all
    const start = performance.now()
    store.apply({ _tag: "Delta", tape: [], candles: [], dayStates: next.moved })
    yield* settle
    yield* inAct(frames.step)
    times.push(performance.now() - start)
  }
  const drawn = lastPrice(container, states)
  yield* inAct(Effect.sync(() => root.unmount()))
  container.remove()
  return { ms: median(times), ...drawn }
})

it.live(
  `a 10% Day state update through the store costs at most ${LIMIT}x plain memo rows, ${ROWS} rows x 6 columns`,
  () =>
    Effect.gen(function* () {
      // Warm both up once, so the JIT favours neither.
      yield* baseline
      yield* throughStore
      const plainMs: Array<number> = []
      const storeMs: Array<number> = []
      for (let round = 0; round < ROUNDS; round++) {
        for (const [run, times] of [
          [baseline, plainMs],
          [throughStore, storeMs],
        ] as const) {
          const { ms, drawn, expected } = yield* run
          assert.strictEqual(drawn, expected)
          times.push(ms)
        }
      }
      const plainTick = median(plainMs)
      const storeTick = median(storeMs)
      const report = `10% tick: store ${storeTick.toFixed(2)} ms, plain memo rows ${plainTick.toFixed(2)} ms (${(storeTick / plainTick).toFixed(2)}x)`
      console.log(report)
      assert.isAtMost(storeTick, LIMIT * plainTick, report)
    }),
  60_000
)
