import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { listedCodes, onDemandMessages } from "../src/worker/ajaib.ts"

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
          codes("TLKM", "GOTO")
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
        yield* onDemandMessages("PRICE", codes("BBCA"), codes("BBCA")),
        []
      )
    })
  )
})

describe("Ajaib's stock code list", () => {
  it.effect("lists every entry's code, warrants included", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        message: "ok",
        data: [
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
