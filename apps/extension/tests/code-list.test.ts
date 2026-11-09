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
import { makeCodeList, type CodeListCache } from "../src/worker/code-list.ts"
import type { Answer, TabRequest } from "../src/worker/broker.ts"

// An instant written as a WIB wall-clock time.
const wib = (dateTime: string) => DateTime.makeUnsafe(`${dateTime}+07:00`)

const LIST = JSON.stringify({ data: [{ code: "BBCA" }, { code: "TLKM" }] })
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
  }
  const tick = (dateTime: string) => codeList.tick(tab, wib(dateTime))
  return {
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
        assert.deepStrictEqual(relay.codeList.codes(), [])
        yield* relay.tick("2026-11-10T08:40:00")
        const envelope = yield* PubSub.take(relay.published)
        // The fetch's fiber finishes its resend after publishing.
        yield* Effect.yieldNow
        const message = yield* decodeIngestUp(envelope)
        assert.strictEqual(message._tag, "CodeList")
        assert.deepStrictEqual(relay.requests, [
          { _tag: "page-fetch", path: CODE_LIST_PATH },
        ])
        assert.deepStrictEqual(relay.codeList.codes(), codes("BBCA", "TLKM"))
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
      assert.deepStrictEqual(relay.codeList.codes(), [])
    })
  )

  it.effect("a held list of the day is not fetched again", () =>
    Effect.gen(function* () {
      const held = yield* heldOn("2026-11-10")
      const relay = yield* harness({ held, answer: ok })
      yield* relay.tick("2026-11-10T08:40:00")
      yield* TestClock.adjust("1 second")
      assert.lengthOf(relay.requests, 0)
      assert.deepStrictEqual(relay.codeList.codes(), codes("BBCA", "TLKM"))
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
        assert.deepStrictEqual(relay.codeList.codes(), codes("BBCA", "TLKM"))
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
})
