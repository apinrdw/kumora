// A body from an archive's source, whose size the source decides, read with
// a cap: every read of one goes through `readCapped`. An archived zip's
// entries are inflated with the same cap (holdings/zip.ts).
import { NonRetryable } from "@workspace/server"
import { Effect, Stream } from "effect"
import type { HttpClientResponse } from "effect/http"

// The body, counted as it streams in, since a source may send no
// Content-Length (www.idx.id's GET sends none), and refused once it passes
// `maxBytes`, before anything decodes it. A body that big won't shrink on a
// retry, so it fails NonRetryable with `<what> is over <maxBytes> bytes`.
export const readCapped = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
  what: string
) =>
  collectCapped(
    response.stream,
    maxBytes,
    () => new NonRetryable({ message: `${what} is over ${maxBytes} bytes` })
  )

// A stream's bytes, counted as they come and refused with `over()` once they
// pass `maxBytes`, which stops the stream there.
export const collectCapped = Effect.fnUntraced(function* <E, Over>(
  stream: Stream.Stream<Uint8Array, E>,
  maxBytes: number,
  over: () => Over
) {
  const read = yield* Stream.runFoldEffect(
    stream,
    () => ({ size: 0, chunks: new Array<Uint8Array>() }),
    (acc, chunk) =>
      acc.size + chunk.length > maxBytes
        ? Effect.fail(over())
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

// A JSON body read with readCapped, as `unknown` for a Schema to decode; one
// that isn't JSON fails NonRetryable with `<what> aren't JSON`.
export const readCappedJson = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
  what: string
) =>
  readCapped(response, maxBytes, what).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
        catch: () => new NonRetryable({ message: `${what} aren't JSON` }),
      })
    )
  )
