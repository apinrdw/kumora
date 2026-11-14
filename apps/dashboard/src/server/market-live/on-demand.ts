// The Ajaib on-demand codes (spec apinrdw/kumora#138, "the ingest envelope"):
// the union of the codes viewers have selected or in a watchlist, sent down
// every ready ingest socket whenever it changes.
import { encodeIngestDown, type StockCode } from "@workspace/relay"
import { Effect } from "effect"

import type { Peer } from "./trading-day.ts"

export const makeOnDemand = Effect.fnUntraced(function* (options: {
  readonly viewers: Effect.Effect<ReadonlyArray<Peer>>
  readonly ingests: Effect.Effect<ReadonlyArray<Peer>>
}) {
  // What the relay was last sent, encoded.
  let sent: string | undefined

  // Every code some viewer selected or watches.
  const watched = Effect.gen(function* () {
    const codes = new Set<StockCode>()
    for (const viewer of yield* options.viewers)
      for (const code of yield* viewer.watching ?? Effect.succeed([]))
        codes.add(code)
    return codes
  })

  // Every code some viewer selected: the first of its codes (trading-day.ts
  // keeps the selected code ahead of the watchlist).
  const selected = Effect.gen(function* () {
    const codes = new Set<StockCode>()
    for (const viewer of yield* options.viewers) {
      const [code] = yield* viewer.watching ?? Effect.succeed([])
      if (code !== undefined) codes.add(code)
    }
    return codes
  })

  const message = Effect.gen(function* () {
    const codes = [...(yield* watched)].sort()
    return {
      empty: codes.length === 0,
      text: yield* encodeIngestDown({ _tag: "OnDemandCodes", codes }),
    }
  })

  // After a viewer's Select or close: the relay hears the set when it changed.
  const update = Effect.gen(function* () {
    const { text } = yield* message
    if (text === sent) return
    sent = text
    for (const ingest of yield* options.ingests)
      if ((yield* ingest.state) === "ready") yield* ingest.send(text)
  })

  // A relay whose token just checked out starts from the current set. The
  // relay counts a target it just connected as wanting none, so an empty set
  // goes unsaid.
  const greet = Effect.fnUntraced(function* (ingest: Peer) {
    const { empty, text } = yield* message
    if (!empty) yield* ingest.send(text)
  })

  return { watched, selected, update, greet }
})
