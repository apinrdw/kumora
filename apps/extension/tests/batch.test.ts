import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { makeBatcher } from "../src/worker/batch.ts"

describe("batching", () => {
  it.effect(
    "one envelope per feed and connection, Stockbit's frames as bytes",
    () =>
      Effect.gen(function* () {
        const batcher = yield* makeBatcher()
        yield* batcher.add("Stockbit", "A", { base64: "CAE=" })
        yield* batcher.add("Ajaib", "A", { text: '{"ticker":"BBCA"}' })
        yield* batcher.add("Ajaib", "A", { text: '{"ticker":"TLKM"}' })
        yield* batcher.add("Ajaib", "B", { text: '{"ticker":"GOTO"}' })
        const envelopes = yield* batcher.flush
        assert.deepStrictEqual(
          envelopes.map((envelope) =>
            envelope._tag === "Frames"
              ? [envelope.feed, envelope.connection, envelope.frames]
              : []
          ),
          [
            ["Stockbit", "A", [Uint8Array.from([8, 1])]],
            ["Ajaib", "A", ['{"ticker":"BBCA"}', '{"ticker":"TLKM"}']],
            ["Ajaib", "B", ['{"ticker":"GOTO"}']],
          ]
        )
        assert.deepStrictEqual(yield* batcher.flush, [])
      })
  )
})
