import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { entryText, MAX_ENTRY_BYTES, zipEntries } from "@/server/holdings/zip"

const NAME = "Balancepos20261030.txt"

const deflated = (bytes: Uint8Array) =>
  Effect.promise(() =>
    new Response(
      new Blob([bytes])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"))
    ).bytes()
  )

// A zip of one deflated entry, `NAME`, whose text is `size` spaces.
const zipOf = Effect.fnUntraced(function* (size: number) {
  const data = yield* deflated(new Uint8Array(size).fill(0x20))
  const name = new TextEncoder().encode(NAME)
  const local = new Uint8Array(30 + name.length)
  const localView = new DataView(local.buffer)
  localView.setUint32(0, 0x04034b50, true)
  localView.setUint16(8, 8, true)
  localView.setUint32(18, data.length, true)
  localView.setUint32(22, size, true)
  localView.setUint16(26, name.length, true)
  local.set(name, 30)
  const central = new Uint8Array(46 + name.length)
  const centralView = new DataView(central.buffer)
  centralView.setUint32(0, 0x02014b50, true)
  centralView.setUint16(10, 8, true)
  centralView.setUint32(20, data.length, true)
  centralView.setUint32(24, size, true)
  centralView.setUint16(28, name.length, true)
  centralView.setUint32(42, 0, true)
  central.set(name, 46)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, 1, true)
  endView.setUint16(10, 1, true)
  endView.setUint32(12, central.length, true)
  endView.setUint32(16, local.length + data.length, true)
  const zip = new Uint8Array(
    local.length + data.length + central.length + end.length
  )
  let at = 0
  for (const part of [local, data, central, end]) {
    zip.set(part, at)
    at += part.length
  }
  return zip
})

const read = Effect.fnUntraced(function* (bytes: Uint8Array) {
  return yield* entryText(bytes, yield* zipEntries(bytes), NAME)
})

describe("a zip entry", () => {
  it.effect("inflates whole at the largest size it accepts", () =>
    Effect.gen(function* () {
      const text = yield* read(yield* zipOf(MAX_ENTRY_BYTES))
      assert.strictEqual(text.length, MAX_ENTRY_BYTES)
    })
  )

  it.effect("is refused once it inflates past the largest size", () =>
    Effect.gen(function* () {
      const bytes = yield* zipOf(MAX_ENTRY_BYTES + 1)
      const error = yield* Effect.flip(
        Effect.map(read(bytes), (text) => text.length)
      )
      assert.strictEqual(
        error.message,
        `${NAME} inflates past ${MAX_ENTRY_BYTES} bytes`
      )
    })
  )
})
