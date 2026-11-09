import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { makeBatcher } from "../src/worker/batch.ts"
import { ajaib, ajaibOnDemand, stockbit } from "../src/worker/broker.ts"

const ajaibPrice = ajaibOnDemand[0]!

describe("batching", () => {
  it.effect(
    "one envelope per feed, connection and Ajaib stream, Stockbit's frames as bytes",
    () =>
      Effect.gen(function* () {
        const batcher = yield* makeBatcher()
        yield* batcher.add(stockbit, "A", { base64: "CAE=" })
        yield* batcher.add(ajaib, "A", { text: '{"ticker":"BBCA"}' })
        yield* batcher.add(ajaibPrice, "A", { text: '{"s":"BBCA"}' })
        yield* batcher.add(ajaib, "A", { text: '{"ticker":"TLKM"}' })
        yield* batcher.add(ajaib, "B", { text: '{"ticker":"GOTO"}' })
        const envelopes = yield* batcher.flush
        assert.deepStrictEqual(
          envelopes.map((envelope) =>
            envelope._tag === "Frames"
              ? [
                  envelope.feed,
                  envelope.connection,
                  envelope.feed === "Ajaib" ? envelope.stream : "",
                  envelope.frames,
                ]
              : []
          ),
          [
            ["Stockbit", "A", "", [Uint8Array.from([8, 1])]],
            ["Ajaib", "A", "trade", ['{"ticker":"BBCA"}', '{"ticker":"TLKM"}']],
            ["Ajaib", "A", "on-demand", ['{"s":"BBCA"}']],
            ["Ajaib", "B", "trade", ['{"ticker":"GOTO"}']],
          ]
        )
        assert.deepStrictEqual(yield* batcher.flush, [])
      })
  )
})
