import { assert, describe, it } from "@effect/vitest"
import {
  type EncodedIngestUp,
  IngestProtocolVersion,
  StockCode,
  WibDate,
  decodeIngestUp,
  encodeIngestUp,
} from "@workspace/relay"
import { DateTime, Effect, Option, PubSub } from "effect"
import { TestClock } from "effect/testing"

import { CODE_LIST_PATH } from "../src/worker/ajaib.ts"
import {
  makeCodeList,
  type CodeListCache,
  type RelayOutcome,
} from "../src/worker/code-list.ts"
import type { Answer, TabRequest } from "../src/worker/broker.ts"
import type { PacedTab } from "../src/worker/pacer.ts"

// An instant written as a WIB wall-clock time.
const wib = (dateTime: string) => DateTime.makeUnsafe(`${dateTime}+07:00`)

const LIST = JSON.stringify({
  results: [
    { code: "BBCA", name: "Bank Central Asia Tbk" },
    { code: "TLKM", name: null },
  ],
})
const codes = (...names: ReadonlyArray<string>) =>
  names.map((name) => StockCode.make(name))

// The list of `date` as the store holds it.
const heldOn = Effect.fnUntraced(function* (date: string) {
  const envelope = yield* encodeIngestUp({
    _tag: "CodeList",
    protocolVersion: IngestProtocolVersion,
    receivedAt: wib(`${date}T08:40:00`),
    body: LIST,
  })
  const held: CodeListCache = {
    date: WibDate.make(date),
    codes: codes("BBCA", "TLKM"),
    envelope,
  }
  return held
})

// An Ajaib tab that answers the list fetch with `answer`, a store in memory
// and a count of the subscribe resends.
const harness = Effect.fnUntraced(function* (options: {
  readonly held?: CodeListCache
  readonly answer: Answer
}) {
  let stored = Option.fromNullishOr(options.held)
  const requests: Array<TabRequest> = []
  let changed = 0
  const envelopes = yield* PubSub.sliding<EncodedIngestUp>(16)
  const published = yield* PubSub.subscribe(envelopes)
  const codeList = yield* makeCodeList({
    store: {
      load: Effect.sync(() => stored),
      save: (list) =>
        Effect.sync(() => {
          stored = Option.some(list)
        }),
    },
    envelopes,
    changed: Effect.sync(() => void changed++),
  })
  const tab = {
    attached: Effect.succeed(true),
    request: (request: TabRequest) =>
      Effect.sync(() => {
        requests.push(request)
        return Option.some(options.answer)
      }),
  } as PacedTab & { readonly attached: Effect.Effect<boolean> }
  const tick = (dateTime: string) => codeList.tick(tab, wib(dateTime))
  const outcomes: Array<RelayOutcome> = []
  const relayNow = (dateTime: string) =>
    codeList.relayNow(tab, wib(dateTime), (outcome) =>
      Effect.sync(() => void outcomes.push(outcome))
    )
  return {
    relayNow,
    outcomes,
    codeList,
    tick,
    requests,
    stored: () => stored,
    changed: () => changed,
    published,
  }
})

const ok: Answer = { _tag: "answer", id: 0, status: 200, body: LIST }
const failed: Answer = { _tag: "answer", id: 0, status: 0, body: "" }

describe("the code list", () => {
  it.effect(
    "is fetched from the Ajaib tab once a day, sent up, kept and resubscribed",
    () =>
      Effect.gen(function* () {
        const relay = yield* harness({ answer: ok })
        assert.deepStrictEqual(yield* relay.codeList.codes, [])
        yield* relay.tick("2026-11-10T08:40:00")
        const envelope = yield* PubSub.take(relay.published)
        // The fetch's fiber finishes its resend after publishing.
        yield* Effect.yieldNow
        const message = yield* decodeIngestUp(envelope)
        assert.strictEqual(message._tag, "CodeList")
        assert.deepStrictEqual(relay.requests, [
          { _tag: "page-fetch", path: CODE_LIST_PATH },
        ])
        assert.deepStrictEqual(
          yield* relay.codeList.codes,
          codes("BBCA", "TLKM")
        )
        assert.strictEqual(
          relay.stored().pipe(Option.getOrUndefined)?.date,
          "2026-11-10"
        )
        assert.strictEqual(relay.changed(), 1)
        yield* TestClock.adjust("2 minutes")
        yield* relay.tick("2026-11-10T08:42:00")
        assert.lengthOf(relay.requests, 1)
      })
  )

  it.effect("a fetch that fails is retried after a minute, not before", () =>
    Effect.gen(function* () {
      const relay = yield* harness({ answer: failed })
      yield* relay.tick("2026-11-10T08:40:00")
      yield* Effect.yieldNow
      yield* TestClock.adjust("30 seconds")
      yield* relay.tick("2026-11-10T08:40:30")
      yield* Effect.yieldNow
      assert.lengthOf(relay.requests, 1)
      yield* TestClock.adjust("31 seconds")
      yield* relay.tick("2026-11-10T08:41:01")
      yield* Effect.yieldNow
      assert.lengthOf(relay.requests, 2)
      assert.deepStrictEqual(yield* relay.codeList.codes, [])
    })
  )

  it.effect("a held list of the day is not fetched again", () =>
    Effect.gen(function* () {
      const held = yield* heldOn("2026-11-10")
      const relay = yield* harness({ held, answer: ok })
      yield* relay.tick("2026-11-10T08:40:00")
      yield* TestClock.adjust("1 second")
      assert.lengthOf(relay.requests, 0)
      assert.deepStrictEqual(yield* relay.codeList.codes, codes("BBCA", "TLKM"))
      assert.deepStrictEqual(
        yield* relay.codeList.catchUp(WibDate.make("2026-11-10")),
        [held.envelope]
      )
    })
  )

  it.effect(
    "a fresh socket of a later day than the held list's is sent no list",
    () =>
      Effect.gen(function* () {
        const held = yield* heldOn("2026-11-09")
        const relay = yield* harness({ held, answer: failed })
        yield* relay.tick("2026-11-10T08:40:00")
        yield* Effect.yieldNow
        // The day's fetch failed, so yesterday's list is still held for the
        // Stockbit subscribe, but it is not today's.
        assert.deepStrictEqual(
          yield* relay.codeList.codes,
          codes("BBCA", "TLKM")
        )
        assert.deepStrictEqual(
          yield* relay.codeList.catchUp(WibDate.make("2026-11-10")),
          []
        )
      })
  )

  it.effect("a held list of an earlier day is fetched anew", () =>
    Effect.gen(function* () {
      const held = yield* heldOn("2026-11-09")
      const relay = yield* harness({ held, answer: ok })
      yield* relay.tick("2026-11-10T08:40:00")
      yield* PubSub.take(relay.published)
      assert.lengthOf(relay.requests, 1)
      assert.strictEqual(
        relay.stored().pipe(Option.getOrUndefined)?.date,
        "2026-11-10"
      )
    })
  )

  describe("relayed by hand", () => {
    it.effect("fetches anew though today's list is held, and sends it", () =>
      Effect.gen(function* () {
        const held = yield* heldOn("2026-11-10")
        const relay = yield* harness({ held, answer: ok })
        yield* relay.relayNow("2026-11-10T18:00:00")
        const message = yield* decodeIngestUp(
          yield* PubSub.take(relay.published)
        )
        yield* Effect.yieldNow
        assert.strictEqual(message._tag, "CodeList")
        assert.lengthOf(relay.requests, 1)
        assert.deepStrictEqual(relay.outcomes, ["fetched"])
      })
    )

    it.effect("sends today's held list again when Ajaib misses", () =>
      Effect.gen(function* () {
        const held = yield* heldOn("2026-11-10")
        const relay = yield* harness({ held, answer: failed })
        yield* relay.relayNow("2026-11-10T18:00:00")
        assert.strictEqual(yield* PubSub.take(relay.published), held.envelope)
        yield* Effect.yieldNow
        assert.deepStrictEqual(relay.outcomes, ["resent"])
      })
    )

    it.effect(
      "sends nothing when Ajaib misses and only an earlier day's list is held",
      () =>
        Effect.gen(function* () {
          const held = yield* heldOn("2026-11-09")
          const relay = yield* harness({ held, answer: failed })
          yield* relay.relayNow("2026-11-10T18:00:00")
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          assert.deepStrictEqual(relay.outcomes, ["missed"])
          assert.strictEqual(yield* PubSub.remaining(relay.published), 0)
        })
    )

    it.effect("answers busy while a fetch is under way", () =>
      Effect.gen(function* () {
        const relay = yield* harness({ answer: ok })
        yield* relay.tick("2026-11-10T08:40:00")
        yield* relay.relayNow("2026-11-10T08:40:01")
        assert.deepStrictEqual(relay.outcomes, ["busy"])
        assert.lengthOf(relay.requests, 0)
      })
    )
  })
})
