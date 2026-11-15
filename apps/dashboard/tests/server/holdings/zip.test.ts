import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

import { entryText, MAX_ENTRY_BYTES, zipEntries } from "@/server/holdings/zip"

import { zipOf } from "./zip-of.ts"

const NAME = "Balancepos20261030.txt"

// A zip of one entry, `NAME`, whose text is `size` spaces.
const zipOfSpaces = (size: number) =>
  zipOf([[NAME, new Uint8Array(size).fill(0x20)]])

const read = Effect.fnUntraced(function* (bytes: Uint8Array) {
  return yield* entryText(bytes, yield* zipEntries(bytes), NAME)
})

describe("a zip entry", () => {
  it.effect("inflates whole at the largest size it accepts", () =>
    Effect.gen(function* () {
      const text = yield* read(yield* zipOfSpaces(MAX_ENTRY_BYTES))
      assert.strictEqual(text.length, MAX_ENTRY_BYTES)
    })
  )

  it.effect("is refused once it inflates past the largest size", () =>
    Effect.gen(function* () {
      const bytes = yield* zipOfSpaces(MAX_ENTRY_BYTES + 1)
      const error = yield* Effect.flip(
        Effect.map(read(bytes), (text) => text.length)
      )
      assert.strictEqual(
        error.message,
        `${NAME} inflates past ${MAX_ENTRY_BYTES} bytes`
      )
    })
  )

  it.effect("stops inflating soon after it passes the largest size", () =>
    Effect.gen(function* () {
      const bytes = yield* zipOfSpaces(8 * MAX_ENTRY_BYTES)
      const Inflate = globalThis.DecompressionStream
      let inflated = 0
      vi.stubGlobal("DecompressionStream", function (format: "deflate-raw") {
        const inflate = new Inflate(format)
        return {
          writable: inflate.writable,
          readable: inflate.readable.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform: (chunk, out) => {
                inflated += chunk.byteLength
                out.enqueue(chunk)
              },
            })
          ),
        }
      })
      const error = yield* Effect.flip(
        Effect.map(read(bytes), (text) => text.length)
      ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())))
      assert.strictEqual(
        error.message,
        `${NAME} inflates past ${MAX_ENTRY_BYTES} bytes`
      )
      assert.isBelow(inflated, 2 * MAX_ENTRY_BYTES)
    })
  )
})
