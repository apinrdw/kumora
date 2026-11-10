import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Queue, Stream } from "effect"

import {
  FrameScheduler,
  makeDayStateStore,
  selectDayState,
  StockCode,
} from "@workspace/client"
import type { DayStateUpdate } from "@workspace/client"
import { manualFrames } from "@workspace/client/testing"

type TestDayState = { readonly last: number }

const BBCA = StockCode.make("BBCA")
const TLKM = StockCode.make("TLKM")

const bbca: TestDayState = { last: 9_800 }
const tlkm: TestDayState = { last: 3_100 }
const initial = new Map<StockCode, TestDayState>([
  [BBCA, bbca],
  [TLKM, tlkm],
])

// A store over a test source the test pushes updates into, with frames
// stepped by hand.
const harness = Effect.gen(function* () {
  const updates = yield* Queue.unbounded<DayStateUpdate<TestDayState>>()
  const frames = yield* manualFrames
  const store = yield* makeDayStateStore({
    source: Stream.fromQueue(updates),
    initial,
  }).pipe(Effect.provideService(FrameScheduler, frames.scheduler))
  const push = (code: StockCode, dayState: TestDayState) =>
    Queue.offer(updates, { code, dayState })
  return { store, frames, push }
})

// Lets the forked source fiber drain what the test pushed.
const settle = Effect.repeat(Effect.yieldNow, { times: 10 })

describe("Day state store", () => {
  it.effect(
    "an update to one stock code changes only that code's selected snapshot",
    () =>
      Effect.gen(function* () {
        const { store, frames, push } = yield* harness
        const unsubscribe = store.subscribe(() => {})
        const next = { last: 9_825 }
        yield* push(BBCA, next)
        yield* settle
        yield* frames.step
        assert.strictEqual(
          yield* selectDayState(store.getSnapshot(), BBCA),
          next
        )
        assert.isTrue(
          Object.is(yield* selectDayState(store.getSnapshot(), TLKM), tlkm)
        )
        unsubscribe()
      })
  )

  it.effect("getSnapshot reflects an update before its frame runs", () =>
    Effect.gen(function* () {
      const { store, push } = yield* harness
      let notified = 0
      const unsubscribe = store.subscribe(() => notified++)
      const before = store.getSnapshot()
      const next = { last: 9_825 }
      yield* push(BBCA, next)
      yield* settle
      const after = store.getSnapshot()
      assert.notStrictEqual(after, before)
      assert.strictEqual(after.get(BBCA), next)
      assert.strictEqual(after.get(TLKM), tlkm)
      assert.strictEqual(notified, 0)
      unsubscribe()
    })
  )

  it.effect("many updates within one frame notify listeners once", () =>
    Effect.gen(function* () {
      const { store, frames, push } = yield* harness
      let notified = 0
      const unsubscribe = store.subscribe(() => notified++)
      yield* push(BBCA, { last: 9_825 })
      yield* push(TLKM, { last: 3_110 })
      yield* push(BBCA, { last: 9_850 })
      yield* settle
      assert.strictEqual(notified, 0)
      yield* frames.step
      assert.strictEqual(notified, 1)
      assert.deepStrictEqual(store.getSnapshot().get(BBCA), { last: 9_850 })
      assert.deepStrictEqual(store.getSnapshot().get(TLKM), { last: 3_110 })
      yield* frames.step
      assert.strictEqual(notified, 1)
      unsubscribe()
    })
  )

  it.effect(
    "the first subscribe starts the source and the last unsubscribe interrupts it",
    () =>
      Effect.gen(function* () {
        const lifetime = { started: 0, stopped: 0 }
        const frames = yield* manualFrames
        const store = yield* makeDayStateStore<TestDayState, never>({
          source: Stream.never.pipe(
            Stream.onStart(Effect.sync(() => lifetime.started++)),
            Stream.ensuring(Effect.sync(() => lifetime.stopped++))
          ),
          initial,
        }).pipe(Effect.provideService(FrameScheduler, frames.scheduler))

        const first = store.subscribe(() => {})
        yield* settle
        const second = store.subscribe(() => {})
        yield* settle
        assert.deepStrictEqual(lifetime, { started: 1, stopped: 0 })

        first()
        yield* settle
        assert.deepStrictEqual(lifetime, { started: 1, stopped: 0 })

        second()
        yield* settle
        assert.deepStrictEqual(lifetime, { started: 1, stopped: 1 })

        const again = store.subscribe(() => {})
        yield* settle
        assert.deepStrictEqual(lifetime, { started: 2, stopped: 1 })
        again()
      })
  )

  it.effect("getServerSnapshot never starts the source", () =>
    Effect.gen(function* () {
      let started = 0
      const frames = yield* manualFrames
      const store = yield* makeDayStateStore<TestDayState, never>({
        source: Stream.never.pipe(Stream.onStart(Effect.sync(() => started++))),
        initial,
      }).pipe(Effect.provideService(FrameScheduler, frames.scheduler))

      assert.strictEqual(
        yield* selectDayState(store.getServerSnapshot(), BBCA),
        bbca
      )
      assert.strictEqual(yield* selectDayState(store.getSnapshot(), BBCA), bbca)
      yield* settle
      yield* frames.step
      assert.strictEqual(started, 0)
    })
  )

  it.effect(
    "keeps the server snapshot at the loader's Day state after updates",
    () =>
      Effect.gen(function* () {
        const { store, frames, push } = yield* harness
        const unsubscribe = store.subscribe(() => {})
        yield* push(BBCA, { last: 9_825 })
        yield* settle
        yield* frames.step
        assert.strictEqual(store.getServerSnapshot(), initial)
        unsubscribe()
      })
  )

  it.effect(
    "notifies the last update of a source that completes before its frame",
    () =>
      Effect.gen(function* () {
        const last = yield* Deferred.make<void>()
        const frames = yield* manualFrames
        const next = { last: 9_825 }
        const store = yield* makeDayStateStore<TestDayState, never>({
          source: Stream.fromEffect(
            Effect.as(Deferred.await(last), { code: BBCA, dayState: next })
          ),
          initial,
        }).pipe(Effect.provideService(FrameScheduler, frames.scheduler))

        let notified = 0
        const unsubscribe = store.subscribe(() => notified++)
        yield* settle
        yield* Deferred.succeed(last, undefined)
        yield* settle
        yield* frames.step
        assert.strictEqual(store.getSnapshot().get(BBCA), next)
        assert.strictEqual(notified, 1)
        unsubscribe()
      })
  )

  it.effect(
    "notifies after resubscribing when the last unsubscribe follows a synchronous update",
    () =>
      Effect.gen(function* () {
        const updates = yield* Queue.unbounded<DayStateUpdate<TestDayState>>()
        const frames = yield* manualFrames
        const store = yield* makeDayStateStore({
          source: Stream.concat(
            Stream.make({ code: BBCA, dayState: { last: 9_825 } }),
            Stream.fromQueue(updates)
          ),
          initial,
        }).pipe(Effect.provideService(FrameScheduler, frames.scheduler))

        store.subscribe(() => {})()
        yield* settle

        let notified = 0
        const again = store.subscribe(() => notified++)
        yield* settle
        yield* Queue.offer(updates, { code: TLKM, dayState: { last: 3_110 } })
        yield* settle
        yield* frames.step
        assert.strictEqual(notified, 1)
        again()
      })
  )

  it.effect(
    "notifies after resubscribing while the stopped source still cleans up",
    () =>
      Effect.gen(function* () {
        const updates = yield* Queue.unbounded<DayStateUpdate<TestDayState>>()
        const cleanedUp = yield* Deferred.make<void>()
        const frames = yield* manualFrames
        const store = yield* makeDayStateStore({
          source: Stream.fromQueue(updates).pipe(
            Stream.ensuring(Deferred.await(cleanedUp))
          ),
          initial,
        }).pipe(Effect.provideService(FrameScheduler, frames.scheduler))

        const first = store.subscribe(() => {})
        yield* Queue.offer(updates, { code: BBCA, dayState: { last: 9_825 } })
        yield* settle
        first()
        yield* settle

        let notified = 0
        const again = store.subscribe(() => notified++)
        yield* settle
        yield* Queue.offer(updates, { code: TLKM, dayState: { last: 3_110 } })
        yield* settle
        yield* Deferred.succeed(cleanedUp, undefined)
        yield* settle
        yield* frames.step
        assert.strictEqual(notified, 1)
        again()
      })
  )

  it.effect("keeps an update whose frame the last unsubscribe cancelled", () =>
    Effect.gen(function* () {
      const { store, frames, push } = yield* harness
      const first = store.subscribe(() => {})
      const next = { last: 9_825 }
      yield* push(BBCA, next)
      yield* settle
      first()
      yield* settle

      let notified = 0
      const again = store.subscribe(() => notified++)
      assert.strictEqual(store.getSnapshot().get(BBCA), next)
      yield* push(TLKM, { last: 3_110 })
      yield* settle
      yield* frames.step
      assert.strictEqual(notified, 1)
      again()
    })
  )
})
