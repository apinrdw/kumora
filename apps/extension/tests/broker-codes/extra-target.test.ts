import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  WibDate,
  decodeBrokerCodesBatch,
  encodeBrokerCodesStatus,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
} from "@workspace/relay"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeExtraTarget } from "../../src/worker/broker-codes/extra-target.ts"
import {
  makeBrokerCodesPoster,
  type BrokerCodesTarget,
  type PostOutcome,
} from "../../src/worker/broker-codes/poster.ts"
import type {
  CatchUpResult,
  WalkResult,
} from "../../src/worker/broker-codes/run-queue.ts"
import { makeTargetHold } from "../../src/worker/broker-codes/target-hold.ts"
import { DashboardOrigin } from "../../src/worker/settings.ts"

const DAY = WibDate.make("2026-11-12")

const PRODUCTION: BrokerCodesTarget = {
  origin: DashboardOrigin.make("https://dashboard.example"),
  token: "production-token",
}
const STAGING: BrokerCodesTarget = {
  origin: DashboardOrigin.make("https://staging.example"),
  token: "staging-token",
}
const PREVIEW: BrokerCodesTarget = {
  origin: DashboardOrigin.make("https://preview.example"),
  token: "preview-token",
}

const CODES = {
  buyer: BrokerCode.make("YP"),
  buyerType: "D",
  seller: BrokerCode.make("PD"),
  sellerType: "F",
} as const

// A dashboard answering each POST with the next of `statuses` (then 200),
// keeping the trade numbers and `end` of every batch it wrote, and
// answering GET with `status`, or with `refusal` as it stands.
const fakeDashboard = (
  options: {
    readonly statuses?: ReadonlyArray<number>
    readonly status?: BrokerCodesStatus
    readonly refusal?: { readonly status: number; readonly body: string }
  } = {}
) => {
  const posts: Array<string> = []
  const written: Array<string> = []
  return {
    posts,
    written,
    send: (request: { url: string; token: string; body: string }) =>
      Effect.gen(function* () {
        posts.push(request.url)
        const status = options.statuses?.[posts.length - 1] ?? 200
        if (status !== 200) return status
        const batch = yield* Effect.orDie(decodeBrokerCodesBatch(request.body))
        for (const [number] of batch.rows) written.push(number)
        if (batch.end !== undefined) written.push(`end ${batch.end.n}`)
        return status
      }),
    get: (_request: { url: string; token: string }) =>
      options.refusal !== undefined
        ? Effect.succeed(options.refusal)
        : options.status === undefined
          ? Effect.succeed({ status: 0, body: "" })
          : Effect.map(
              Effect.orDie(encodeBrokerCodesStatus(options.status)),
              (body) => ({ status: 200, body })
            ),
  }
}

const batch = (numbers: ReadonlyArray<number>, n?: number) =>
  ({
    version: BrokerCodesProtocolVersion,
    feed: "Ajaib",
    day: DAY,
    rows: numbers.map((number) => [TradeNumber.make(`${number}`), CODES]),
    ...(n === undefined ? {} : { end: { n: TradeNumber.make(`${n}`) } }),
  }) satisfies BrokerCodesBatch

// A day's status: the trades held, the ranges missing, and n when known;
// `missingCount` past what the ranges hold for a list cut short.
const holding = (options: {
  readonly n: number | null
  readonly missing: ReadonlyArray<readonly [number, number]>
  readonly held: number
  readonly missingCount?: number
}): BrokerCodesStatus => ({
  version: BrokerCodesProtocolVersion,
  day: DAY,
  n: options.n === null ? null : TradeNumber.make(`${options.n}`),
  complete: options.n !== null && options.missing.length === 0,
  missing: options.missing.map(([from, to]) => [
    TradeNumber.make(`${from}`),
    TradeNumber.make(`${to}`),
  ]),
  missingCount:
    options.missingCount ??
    options.missing.reduce((sum, [from, to]) => sum + to - from + 1, 0),
  sources: { ajaib: options.held, stockbit: 0 },
  crossCheck: { state: "none" },
})
const COMPLETE = holding({ n: 5, missing: [], held: 5 })

// A walk of trades 1..5 over a fake tape: one fetch per page of two trades,
// each page posted as one batch, then `end`.
const fakeWalk = (
  post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
) => {
  let fetches = 0
  return {
    fetches: () => fetches,
    walk: (_day: WibDate) =>
      Effect.gen(function* () {
        for (const page of [[1, 2], [3, 4], [5]]) {
          fetches++
          const outcome = yield* post(batch(page))
          if (outcome !== "sent")
            return {
              _tag: "stopped",
              cause: outcome === "off" ? "no-token" : outcome,
            } satisfies WalkResult
        }
        yield* post(batch([], 5))
        return { _tag: "walked" } satisfies WalkResult
      }),
  }
}

const harness = Effect.fnUntraced(function* (options: {
  readonly production?: ReturnType<typeof fakeDashboard>
  readonly extra: ReturnType<typeof fakeDashboard>
  readonly settings?: Option.Option<BrokerCodesTarget>
}) {
  const production = options.production ?? fakeDashboard()
  let settings = options.settings ?? Option.some(STAGING)
  const reported: Array<string> = []
  const changed: Effect.Effect<void> = Effect.suspend(() =>
    Effect.map(hold.state, (state) => {
      reported.push(Option.getOrElse(state, () => "cleared"))
    })
  )
  const hold = yield* makeTargetHold(changed)
  yield* hold.restart(settings)
  const extra = yield* makeExtraTarget({
    production: Effect.succeed(Option.some(PRODUCTION)),
    send: options.extra.send,
    get: (request) =>
      request.url.startsWith(PRODUCTION.origin)
        ? production.get(request)
        : options.extra.get(request),
    hold,
  })
  yield* Effect.forkChild(extra.run)
  const poster = yield* makeBrokerCodesPoster({
    target: Effect.succeed(Option.some(PRODUCTION)),
    send: production.send,
  })
  return {
    production,
    reported,
    hold,
    extra,
    post: extra.tee(poster.post),
    // The settings change as makeTargets in service-worker.ts applies them.
    switchTo: (next: BrokerCodesTarget) =>
      Effect.suspend(() => {
        settings = Option.some(next)
        return hold.restart(settings)
      }),
  }
})

// Lets the extra target's lane send what it holds.
const settle = Effect.repeat(Effect.yieldNow, { times: 50 })

describe("the extra target", () => {
  it.effect("gets every batch a walk posts, from one fetch of each page", () =>
    Effect.gen(function* () {
      const extra = fakeDashboard()
      const target = yield* harness({ extra })
      const walk = fakeWalk(target.post)
      assert.deepStrictEqual(yield* walk.walk(DAY), { _tag: "walked" })
      yield* settle
      const all = ["1", "2", "3", "4", "5", "end 5"]
      assert.deepStrictEqual(target.production.written, all)
      assert.deepStrictEqual(extra.written, all)
      assert.strictEqual(walk.fetches(), 3)
      assert.ok(
        extra.posts.every((url) =>
          url.startsWith("https://staging.example/api/broker-codes/")
        )
      )
    })
  )

  it.effect("failing, never holds Production up", () =>
    Effect.gen(function* () {
      const extra = fakeDashboard({ statuses: Array(1000).fill(503) })
      const target = yield* harness({ extra })
      assert.deepStrictEqual(yield* fakeWalk(target.post).walk(DAY), {
        _tag: "walked",
      })
      assert.deepStrictEqual(target.production.written, [
        "1",
        "2",
        "3",
        "4",
        "5",
        "end 5",
      ])
      assert.deepStrictEqual(extra.written, [])
    })
  )

  // A target the browser can't reach (status 0: no CORS, DNS, offline) is
  // retried, and shown as retrying until a batch goes through.
  it.effect("unreachable, shows retrying until a batch is written", () =>
    Effect.gen(function* () {
      const extra = fakeDashboard({ statuses: [0, 0] })
      const target = yield* harness({ extra })
      yield* fakeWalk(target.post).walk(DAY)
      yield* settle
      assert.deepStrictEqual(target.reported, ["retrying"])
      yield* TestClock.adjust("1 minute")
      yield* settle
      assert.deepStrictEqual(target.reported, ["retrying", "cleared"])
      assert.lengthOf(extra.written, 6)
    })
  )

  // The new settings' first failure shows again; makeTargets in
  // service-worker.ts says why.
  it.effect("shows retrying again when new settings fail too", () =>
    Effect.gen(function* () {
      const extra = fakeDashboard({ statuses: [0, 0] })
      const target = yield* harness({
        extra,
      })
      yield* fakeWalk(target.post).walk(DAY)
      yield* settle
      assert.deepStrictEqual(target.reported, ["retrying"])
      yield* target.switchTo({ ...STAGING, token: "new-token" })
      yield* TestClock.adjust("1 second")
      yield* settle
      assert.deepStrictEqual(target.reported, ["retrying", "retrying"])
      yield* TestClock.adjust("2 seconds")
      yield* settle
      assert.deepStrictEqual(target.reported, [
        "retrying",
        "retrying",
        "cleared",
      ])
      // The batch retrying on the old settings is dropped for the catch-up.
      assert.deepStrictEqual(extra.written, ["3", "4", "5", "end 5"])
    })
  )

  it.effect(
    "a 401 or 426 sets its target state and stops it until its settings change",
    () =>
      Effect.gen(function* () {
        for (const [status, state] of [
          [401, "rejected-token"],
          [426, "reload-extension"],
        ] as const) {
          const extra = fakeDashboard({ statuses: [status] })
          const target = yield* harness({
            extra,
          })
          yield* fakeWalk(target.post).walk(DAY)
          yield* settle
          assert.deepStrictEqual(target.reported, [state])
          assert.lengthOf(extra.posts, 1)
          assert.lengthOf(target.production.written, 6)
          yield* target.switchTo({ ...STAGING, token: "new-token" })
          yield* fakeWalk(target.post).walk(DAY)
          yield* settle
          assert.deepStrictEqual(extra.written, [
            "1",
            "2",
            "3",
            "4",
            "5",
            "end 5",
          ])
        }
      })
  )

  // Codex review round 10: A's refusal came back after A, B, then A again.
  it.effect("refused on A, then set to B and back to A, sends to A again", () =>
    Effect.gen(function* () {
      const extra = fakeDashboard({ statuses: [401] })
      const target = yield* harness({ extra })
      yield* fakeWalk(target.post).walk(DAY)
      yield* settle
      assert.deepStrictEqual(target.reported, ["rejected-token"])
      yield* target.switchTo(PREVIEW)
      yield* target.switchTo(STAGING)
      assert.isTrue(Option.isNone(yield* target.hold.state))
      yield* fakeWalk(target.post).walk(DAY)
      yield* settle
      assert.deepStrictEqual(extra.written, ["1", "2", "3", "4", "5", "end 5"])
    })
  )

  it.effect("no state of A's settings carries over to B's", () =>
    Effect.gen(function* () {
      for (const [status, state] of [
        [401, "rejected-token"],
        [426, "reload-extension"],
        [503, "retrying"],
      ] as const) {
        const extra = fakeDashboard({ statuses: [status] })
        const target = yield* harness({ extra })
        yield* fakeWalk(target.post).walk(DAY)
        yield* settle
        assert.deepStrictEqual(target.reported, [state])
        yield* target.switchTo(PREVIEW)
        assert.isTrue(Option.isNone(yield* target.hold.state))
        yield* fakeWalk(target.post).walk(DAY)
        yield* TestClock.adjust("1 minute")
        yield* settle
        // B's requests all go through: nothing new to show.
        assert.deepStrictEqual(target.reported, [state])
        assert.isTrue(
          extra.posts.slice(1).every((url) => url.startsWith(PREVIEW.origin))
        )
        assert.include(extra.written, "end 5")
      }
    })
  )

  it.effect("an answer to A's request, once on B, leaves B's state alone", () =>
    Effect.gen(function* () {
      for (const status of [401, 426, 503]) {
        const dashboard = fakeDashboard({ statuses: [status] })
        // The settings change while the first POST is in flight.
        let inFlight: Effect.Effect<void> = Effect.void
        const target = yield* harness({
          extra: {
            ...dashboard,
            send: (request) =>
              Effect.andThen(
                Effect.suspend(() => {
                  const now = inFlight
                  inFlight = Effect.void
                  return now
                }),
                dashboard.send(request)
              ),
          },
        })
        inFlight = target.switchTo(PREVIEW)
        yield* fakeWalk(target.post).walk(DAY)
        yield* TestClock.adjust("1 minute")
        yield* settle
        assert.deepStrictEqual(target.reported, [])
        assert.isTrue(Option.isNone(yield* target.hold.state))
        assert.isTrue(dashboard.posts[0]?.startsWith(STAGING.origin))
        assert.isTrue(
          dashboard.posts
            .slice(1)
            .every((url) => url.startsWith(PREVIEW.origin))
        )
        assert.include(dashboard.written, "end 5")
      }
    })
  )

  it.effect("a status read refused on A leaves B reading again", () =>
    Effect.gen(function* () {
      let reads = 0
      const extra = fakeDashboard({ status: COMPLETE })
      const target = yield* harness({
        production: fakeDashboard({ status: COMPLETE }),
        extra: {
          ...extra,
          get: (request) =>
            Effect.suspend(() => {
              reads++
              return reads === 1
                ? Effect.succeed({ status: 401, body: "" })
                : extra.get(request)
            }),
        },
      })
      const catchUp = yield* target.extra.catchUp("Ajaib", ({ post }) =>
        Effect.sync(() => fakeWalk(post))
      )
      assert.deepStrictEqual(yield* catchUp.walk(DAY), { _tag: "stopped" })
      assert.deepStrictEqual(target.reported, ["rejected-token"])
      yield* target.switchTo(PREVIEW)
      assert.deepStrictEqual(yield* catchUp.walk(DAY), { _tag: "walked" })
      assert.strictEqual(reads, 2)
      assert.isTrue(Option.isNone(yield* target.hold.state))
    })
  )

  it.effect(
    "settings changed during a retry drop it, and their own 401 stops them",
    () =>
      Effect.gen(function* () {
        const extra = fakeDashboard({ statuses: [503, 401] })
        const target = yield* harness({
          extra,
        })
        yield* fakeWalk(target.post).walk(DAY)
        yield* settle
        assert.lengthOf(extra.posts, 1)
        yield* target.switchTo({ ...STAGING, token: "new-token" })
        yield* TestClock.adjust("1 minute")
        yield* settle
        assert.deepStrictEqual(target.reported, ["retrying", "rejected-token"])
        assert.lengthOf(extra.posts, 2)
        assert.deepStrictEqual(extra.written, [])
      })
  )

  it.effect(
    "catches up from its own status: only the trades it misses, never to Production",
    () =>
      Effect.gen(function* () {
        const production = fakeDashboard({ status: COMPLETE })
        // It holds 1 and 4: 2 and 3 are missing, and 5 is past its highest.
        const extra = fakeDashboard({
          status: holding({ n: null, missing: [[2, 3]], held: 2 }),
        })
        const target = yield* harness({ production, extra })
        let walk: ReturnType<typeof fakeWalk> | undefined
        const catchUp = yield* target.extra.catchUp("Ajaib", ({ post }) =>
          Effect.sync(() => {
            walk = fakeWalk(post)
            return walk
          })
        )
        assert.strictEqual(catchUp.feed, "Ajaib")
        assert.deepStrictEqual(yield* catchUp.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(extra.written, ["2", "3", "5", "end 5"])
        assert.deepStrictEqual(production.written, [])
        assert.strictEqual(walk?.fetches(), 3)
      })
  )

  it.effect(
    "catching up while its n is unknown, counts a trade it holds codes alone of once",
    () =>
      Effect.gen(function* () {
        // It holds 1 and 4, and 2's codes alone: 2 and 3 are missing, and 5
        // is past its highest.
        const extra = fakeDashboard({
          status: holding({ n: null, missing: [[2, 3]], held: 3 }),
        })
        const target = yield* harness({
          production: fakeDashboard({ status: COMPLETE }),
          extra,
        })
        const catchUp = yield* target.extra.catchUp("Ajaib", ({ post }) =>
          Effect.sync(() => fakeWalk(post))
        )
        assert.deepStrictEqual(yield* catchUp.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(extra.written, ["2", "3", "5", "end 5"])
      })
  )

  it.effect(
    "catching up from a list cut short, sends every trade past its last range",
    () =>
      Effect.gen(function* () {
        // It lacks 2, 4 and 5, but its list stops after 2.
        const extra = fakeDashboard({
          status: holding({
            n: 5,
            missing: [[2, 2]],
            held: 2,
            missingCount: 3,
          }),
        })
        const target = yield* harness({
          production: fakeDashboard({ status: COMPLETE }),
          extra,
        })
        const catchUp = yield* target.extra.catchUp("Ajaib", ({ post }) =>
          Effect.sync(() => fakeWalk(post))
        )
        assert.deepStrictEqual(yield* catchUp.walk(DAY), { _tag: "walked" })
        assert.deepStrictEqual(extra.written, ["2", "3", "4", "5", "end 5"])
      })
  )

  it.effect(
    "skips the catch-up when it is complete or lacks only what Production lacks, and stops it when unreachable or not set",
    () =>
      Effect.gen(function* () {
        const gap = holding({ n: 5, missing: [[2, 3]], held: 3 })
        const walked: CatchUpResult = { _tag: "walked" }
        // Nothing caught up: a History catch-up keeps its position.
        const stopped: CatchUpResult = { _tag: "stopped" }
        const cases = [
          [COMPLETE, COMPLETE, Option.some(STAGING), walked],
          [gap, gap, Option.some(STAGING), walked],
          [COMPLETE, undefined, Option.some(STAGING), stopped],
          [COMPLETE, gap, Option.none(), stopped],
        ] as const
        for (const [lead, held, settings, result] of cases) {
          const extra = fakeDashboard(
            held === undefined ? {} : { status: held }
          )
          const target = yield* harness({
            production: fakeDashboard({ status: lead }),
            extra,
            settings,
          })
          let walks = 0
          const catchUp = yield* target.extra.catchUp("Ajaib", ({ post }) =>
            Effect.sync(() => {
              const walk = fakeWalk(post)
              return {
                walk: (day: WibDate) =>
                  Effect.suspend(() => {
                    walks++
                    return walk.walk(day)
                  }),
              }
            })
          )
          assert.deepStrictEqual(yield* catchUp.walk(DAY), result)
          assert.strictEqual(walks, 0)
          assert.deepStrictEqual(extra.written, [])
        }
      })
  )

  it.effect(
    "a status read's 401, 426 or other version stops it as a post's would",
    () =>
      Effect.gen(function* () {
        for (const [refusal, state] of [
          [{ status: 401, body: "" }, "rejected-token"],
          [{ status: 426, body: "" }, "reload-extension"],
          [{ status: 200, body: '{"version":0}' }, "reload-extension"],
        ] as const) {
          const extra = fakeDashboard({ refusal })
          const target = yield* harness({
            production: fakeDashboard({ status: COMPLETE }),
            extra,
          })
          const catchUp = yield* target.extra.catchUp("Ajaib", ({ post }) =>
            Effect.sync(() => fakeWalk(post))
          )
          assert.deepStrictEqual(yield* catchUp.walk(DAY), { _tag: "stopped" })
          assert.deepStrictEqual(target.reported, [state])
          yield* fakeWalk(target.post).walk(DAY)
          yield* settle
          assert.deepStrictEqual(extra.posts, [])
        }
      })
  )

  // Codex review round 11: the poster's retries never asked the hold again.
  it.effect("a refusal recorded while a post retries stops its retries", () =>
    Effect.gen(function* () {
      const extra = fakeDashboard({
        statuses: Array(1000).fill(503),
        refusal: { status: 401, body: "" },
      })
      const target = yield* harness({
        production: fakeDashboard({ status: COMPLETE }),
        extra,
      })
      yield* target.post(batch([1]))
      yield* settle
      assert.lengthOf(extra.posts, 1)
      const catchUp = yield* target.extra.catchUp("Ajaib", ({ post }) =>
        Effect.sync(() => fakeWalk(post))
      )
      assert.deepStrictEqual(yield* catchUp.walk(DAY), { _tag: "stopped" })
      assert.strictEqual(target.reported.at(-1), "rejected-token")
      yield* TestClock.adjust("10 minutes")
      yield* settle
      assert.lengthOf(extra.posts, 1)
    })
  )

  // Domain pass, review round 12: the walk reported `no-token`, which is
  // Production's cause for a missing token.
  it.effect(
    "a catch-up walk whose settings change mid-run stops with no cause",
    () =>
      Effect.gen(function* () {
        const extra = fakeDashboard({
          status: holding({ n: null, missing: [], held: 0 }),
        })
        const target = yield* harness({
          production: fakeDashboard({ status: COMPLETE }),
          extra,
        })
        let posted = 0
        const catchUp = yield* target.extra.catchUp("Ajaib", ({ post }) =>
          Effect.sync(() =>
            fakeWalk((each) =>
              Effect.suspend(() => {
                posted++
                return posted === 2
                  ? Effect.andThen(target.switchTo(PREVIEW), post(each))
                  : post(each)
              })
            )
          )
        )
        const result = yield* catchUp.walk(DAY)
        assert.strictEqual(result._tag, "stopped")
        assert.notProperty(result, "cause")
        assert.deepStrictEqual(extra.written, ["1", "2"])
      })
  )

  it.effect(
    "a catch-up walk's posts and status reads stay on the settings it began with",
    () =>
      Effect.gen(function* () {
        const extra = fakeDashboard({
          status: holding({ n: null, missing: [], held: 0 }),
        })
        const target = yield* harness({
          production: fakeDashboard({ status: COMPLETE }),
          extra,
        })
        const reads: Array<string> = []
        const catchUp = yield* target.extra.catchUp(
          "Ajaib",
          ({ post, status, origin }) =>
            Effect.sync(() => ({
              walk: (_day: WibDate) =>
                Effect.gen(function* () {
                  assert.strictEqual(yield* post(batch([1])), "sent")
                  yield* target.switchTo(PREVIEW)
                  assert.strictEqual(yield* post(batch([2])), "off")
                  assert.isTrue(Option.isNone(yield* status(DAY)))
                  assert.isTrue(Option.isNone(yield* origin))
                  reads.push("done")
                  return {
                    _tag: "stopped",
                    cause: "no-token",
                  } satisfies WalkResult
                }),
            }))
        )
        yield* catchUp.walk(DAY)
        assert.deepStrictEqual(reads, ["done"])
        assert.deepStrictEqual(extra.written, ["1"])
        assert.isTrue(
          extra.posts.every((url) => url.startsWith(STAGING.origin))
        )
      })
  )
})
