// Frames gathered per feed and connection and sent as one envelope each about
// every 250 ms (spec apinrdw/kumora#138, "Batching and targets").
import {
  IngestProtocolVersion,
  type Connection,
  type Feed,
  type IngestUp,
} from "@workspace/relay"
import { DateTime, Effect, Result } from "effect"
import * as Base64 from "effect/encoding/Base64"

import type { Payload } from "./broker.ts"

export const BATCH_INTERVAL = "250 millis"

export const makeBatcher = Effect.fnUntraced(function* () {
  // Ajaib's JSON text, and Stockbit's protobuf bytes.
  const ajaib = new Map<Connection, Array<string>>()
  const stockbit = new Map<Connection, Array<Uint8Array>>()

  const add = Effect.fnUntraced(function* (
    feed: Feed,
    connection: Connection,
    payload: Payload
  ) {
    if (feed === "Ajaib" && "text" in payload) {
      const buffer = ajaib.get(connection)
      if (buffer === undefined) ajaib.set(connection, [payload.text])
      else buffer.push(payload.text)
    } else if (feed === "Stockbit" && "base64" in payload) {
      const decoded = Base64.decode(payload.base64)
      if (Result.isFailure(decoded)) return
      const frame = decoded.success
      const buffer = stockbit.get(connection)
      if (buffer === undefined) stockbit.set(connection, [frame])
      else buffer.push(frame)
    }
  })

  // The envelopes for every connection that received frames since the last
  // flush, stamped with the flush time.
  const flush = Effect.gen(function* () {
    const receivedAt = yield* DateTime.now
    const envelopes: Array<IngestUp> = []
    const base = { protocolVersion: IngestProtocolVersion, receivedAt }
    for (const [connection, frames] of stockbit)
      envelopes.push({
        _tag: "Frames",
        ...base,
        feed: "Stockbit",
        connection,
        frames,
      })
    for (const [connection, frames] of ajaib)
      envelopes.push({
        _tag: "Frames",
        ...base,
        feed: "Ajaib",
        stream: "trade",
        connection,
        frames,
      })
    stockbit.clear()
    ajaib.clear()
    return envelopes
  })

  return { add, flush }
})
