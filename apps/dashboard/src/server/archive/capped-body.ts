// A body from an archive's source, whose size the source decides, read with
// a cap: every read of one goes through `readCapped`.
import { NonRetryable } from "@workspace/server"
import { Effect, Stream } from "effect"
import type { HttpClientResponse } from "effect/http"

// The body, counted as it streams in, since a source may send no
// Content-Length (www.idx.id's GET sends none), and refused once it passes
// `maxBytes`, before anything decodes it. A body that big won't shrink on a
// retry, so it fails NonRetryable with `<what> is over <maxBytes> bytes`.
export const readCapped = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
  what: string
) {
  const read = yield* Stream.runFoldEffect(
    response.stream,
    () => ({ size: 0, chunks: new Array<Uint8Array>() }),
    (acc, chunk) =>
      acc.size + chunk.length > maxBytes
        ? Effect.fail(
            new NonRetryable({ message: `${what} is over ${maxBytes} bytes` })
          )
        : Effect.sync(() => {
            acc.chunks.push(chunk)
            return { size: acc.size + chunk.length, chunks: acc.chunks }
          })
  )
  const bytes = new Uint8Array(read.size)
  let offset = 0
  for (const chunk of read.chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
})
