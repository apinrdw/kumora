// A React element rendered as the Worker renders a page: React's edge
// server build, each chunk read and let go, so the heap holds what the
// render holds and not the HTML. It gives the HTML's table rows (`<tr`) and
// the first text each of `patterns` matches.
import { Effect, Stream } from "effect"
import type { ReactNode } from "react"
import { renderToReadableStream } from "react-dom/server.edge"

// The longest text a pattern matches across two chunks.
const CARRY = 512

export const serverRender = Effect.fnUntraced(function* <Name extends string>(
  node: ReactNode,
  patterns: Record<Name, RegExp>
) {
  const stream = yield* Effect.promise(() => renderToReadableStream(node))
  const names = Object.keys(patterns) as Array<Name>
  const found = new Map<Name, string>()
  const decoder = new TextDecoder()
  let rows = 0
  // A `<tr` the last chunk's end cut.
  let cut = ""
  let tail = ""
  yield* Stream.fromReadableStream({
    evaluate: () => stream,
    onError: (cause) => new Error("The render's stream failed", { cause }),
  }).pipe(
    Stream.runForEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        const text = decoder.decode(chunk, { stream: true })
        const joined = cut + text
        rows += joined.split("<tr").length - 1
        cut = joined.endsWith("<t") ? "<t" : joined.endsWith("<") ? "<" : ""
        const window = tail + text
        for (const name of names) {
          const match = found.has(name) ? null : patterns[name].exec(window)
          if (match) found.set(name, match.slice(1).join(": "))
        }
        tail = window.slice(-CARRY)
      })
    )
  )
  return { rows, found }
})
