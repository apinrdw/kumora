import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Option } from "effect"

import {
  AjaibAccountId,
  listedCodes,
  onDemandMessages,
  tradeSubscribe,
} from "../src/worker/ajaib.ts"

// The dashboard's capture of Ajaib's list answer, shared, not copied.
import recordedList from "../../dashboard/tests/server/market-live/fixtures/ajaib-code-list-2026-11-09.json"

const codes = (...names: ReadonlyArray<string>) =>
  names.map((name) => StockCode.make(name))

describe("Ajaib's on-demand subscriptions", () => {
  it.effect(
    "subscribe each added code once and unsubscribe each removed one",
    () =>
      Effect.gen(function* () {
        const messages = yield* onDemandMessages(
          "ORDER_BOOK_CUSTOM",
          codes("BBCA", "TLKM"),
          codes("TLKM", "GOTO"),
          Option.none()
        )
        assert.deepStrictEqual(messages, [
          {
            text: '{"method":"UNSUBSCRIBE","stream":"ORDER_BOOK_CUSTOM","streamObject":"BBCA"}',
          },
          {
            text: '{"method":"SUBSCRIBE","stream":"ORDER_BOOK_CUSTOM","streamObject":"GOTO"}',
          },
        ])
      })
  )

  it.effect("an unchanged set sends nothing", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* onDemandMessages(
          "PRICE",
          codes("BBCA"),
          codes("BBCA"),
          Option.none()
        ),
        []
      )
    })
  )
})

describe("Ajaib's subscribe frames", () => {
  it.effect("carry the account id once it is known, as the page's do", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* onDemandMessages(
          "INDICATIVE",
          [],
          codes("BBCA"),
          Option.some(AjaibAccountId.make(4999301))
        ),
        [
          {
            text: '{"method":"SUBSCRIBE","id":4999301,"stream":"INDICATIVE","streamObject":"BBCA"}',
          },
        ]
      )
      assert.deepStrictEqual(
        yield* tradeSubscribe(Option.some(AjaibAccountId.make(4999301))),
        {
          text: '{"method":"SUBSCRIBE","id":4999301,"stream":"TRADE","streamObject":"*"}',
        }
      )
    })
  )

  it.effect("without an id, are the id-less frames the relay always sent", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* tradeSubscribe(Option.none()), {
        text: '{"method":"SUBSCRIBE","stream":"TRADE","streamObject":"*"}',
      })
    })
  )

  it("take only an account id as the id, never a stream's name", () => {
    const id: Option.Option<AjaibAccountId> = Option.some(
      AjaibAccountId.make(4999301)
    )
    // @ts-expect-error a stream name is not an AjaibAccountId
    const stream: Option.Option<AjaibAccountId> = Option.some("INDICATIVE")
    assert.isTrue(Option.isSome(id) && Option.isSome(stream))
  })
})

describe("Ajaib's stock code list", () => {
  it.effect("lists every entry's code, warrants included", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        err_code: "EC0000000",
        results: [
          { code: "BBCA", name: "Bank Central Asia Tbk.", watchlisted: false },
          { code: "BUKA-W", name: "Waran Bukalapak", watchlisted: false },
        ],
      })
      assert.deepStrictEqual(yield* listedCodes(body), codes("BBCA", "BUKA-W"))
    })
  )

  it.effect("an answer that isn't a list lists nothing", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* listedCodes('{"detail":"forbidden"}'), [])
      assert.deepStrictEqual(yield* listedCodes("<html>"), [])
    })
  )
})

describe("Ajaib's stock code list, as the 2026-11-09 probe recorded it", () => {
  it.effect("lists every non-empty code of the recorded answer", () =>
    Effect.gen(function* () {
      const listed = yield* listedCodes(recordedList.body)
      assert.lengthOf(listed, 13)
      assert.include(listed, StockCode.make("BBCA"))
      assert.include(listed, StockCode.make("AMAG-W2"))
      assert.include(listed, StockCode.make("R-LQ45X"))
      assert.notInclude(listed.map(String), "")
    })
  )
})
