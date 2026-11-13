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

import { makeExtraTarget } from "../../src/worker/broker-codes/extra-target.ts"
import {
  makeBrokerCodesPoster,
  type BrokerCodesTarget,
  type PostOutcome,
} from "../../src/worker/broker-codes/poster.ts"
import type { WalkResult } from "../../src/worker/broker-codes/run-queue.ts"
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

const CODES = {
  buyer: BrokerCode.make("YP"),
  buyerType: "D",
  seller: BrokerCode.make("PD"),
  sellerType: "F",
} as const

// A dashboard answering each POST with the next of `statuses` (then 200),
// keeping the trade numbers and `end` of every batch it wrote, and
// answering GET with `status`.
const fakeDashboard = (
  options: {
    readonly statuses?: ReadonlyArray<number>
    readonly status?: BrokerCodesStatus
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
      options.status === undefined
        ? Effect.succeed(Option.none<string>())
        : Effect.map(
            Effect.orDie(encodeBrokerCodesStatus(options.status)),
            Option.some
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

// A day's status: the trades held, the ranges missing, and n when known.
const holding = (options: {
  readonly n: number | null
  readonly missing: ReadonlyArray<readonly [number, number]>
  readonly held: number
}): BrokerCodesStatus => ({
  version: BrokerCodesProtocolVersion,
  day: DAY,
  n: options.n === null ? null : TradeNumber.make(`${options.n}`),
  complete: options.n !== null && options.missing.length === 0,
  missing: options.missing.map(([from, to]) => [
    TradeNumber.make(`${from}`),
    TradeNumber.make(`${to}`),
  ]),
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
  readonly target?: () => Option.Option<BrokerCodesTarget>
}) {
  const production = options.production ?? fakeDashboard()
  const reported: Array<string> = []
  const extra = yield* makeExtraTarget({
    target: Effect.sync(options.target ?? (() => Option.some(STAGING))),
    production: Effect.succeed(Option.some(PRODUCTION)),
    send: options.extra.send,
    get: (request) =>
      request.url.startsWith(PRODUCTION.origin)
        ? production.get(request)
        : options.extra.get(request),
    report: (state) => Effect.sync(() => reported.push(state)),
  })
  yield* Effect.forkChild(extra.run)
  const poster = yield* makeBrokerCodesPoster({
    target: Effect.succeed(Option.some(PRODUCTION)),
    send: production.send,
  })
  return { production, reported, extra, post: extra.tee(poster.post) }
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
      assert.deepStrictEqual(target.reported, [])
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
          let settings = STAGING
          const target = yield* harness({
            extra,
            target: () => Option.some(settings),
          })
          yield* fakeWalk(target.post).walk(DAY)
          yield* settle
          assert.deepStrictEqual(target.reported, [state])
          assert.lengthOf(extra.posts, 1)
          assert.lengthOf(target.production.written, 6)
          settings = { ...STAGING, token: "new-token" }
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
    "skips the catch-up when it is complete or lacks only what Production lacks, and stops it when unreachable or not set",
    () =>
      Effect.gen(function* () {
        const gap = holding({ n: 5, missing: [[2, 3]], held: 3 })
        const walked: WalkResult = { _tag: "walked" }
        // Nothing caught up: a History catch-up keeps its position.
        const stopped: WalkResult = { _tag: "stopped", cause: "no-token" }
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
            target: () => settings,
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
})
