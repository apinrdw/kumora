// Frames gathered per feed and connection and sent as one envelope each about
// every 250 ms (spec apinrdw/kumora#138, "Batching and targets"), or sooner
// for a connection the tab reports closed (tab.ts).
import {
  IngestProtocolVersion,
  type Connection,
  type Feed,
  type FrameStream,
  type IngestUp,
} from "@workspace/relay"
import { DateTime, Effect, Result } from "effect"
import * as Base64 from "effect/encoding/Base64"

import type { BrokerSite, Payload } from "./broker.ts"

export const BATCH_INTERVAL = "250 millis"

export const makeBatcher = Effect.fnUntraced(function* () {
  // Ajaib's JSON text per connection and stream, and Stockbit's protobuf
  // bytes per connection.
  const ajaib: Array<{
    readonly connection: Connection
    readonly stream: FrameStream
    readonly frames: Array<string>
  }> = []
  const stockbit = new Map<Connection, Array<Uint8Array>>()

  const add = Effect.fnUntraced(function* (
    site: Pick<BrokerSite, "feed" | "stream">,
    connection: Connection,
    payload: Payload
  ) {
    if (site.feed === "Ajaib" && "text" in payload) {
      const held = ajaib.find(
        (bucket) =>
          bucket.connection === connection && bucket.stream === site.stream
      )
      if (held === undefined)
        ajaib.push({ connection, stream: site.stream, frames: [payload.text] })
      else held.frames.push(payload.text)
    } else if (site.feed === "Stockbit" && "base64" in payload) {
      const decoded = Base64.decode(payload.base64)
      if (Result.isFailure(decoded)) return
      const frame = decoded.success
      const buffer = stockbit.get(connection)
      if (buffer === undefined) stockbit.set(connection, [frame])
      else buffer.push(frame)
    }
  })

  // The envelopes of every held connection `chosen` picks, stamped with the
  // time they are taken; the batcher forgets their frames.
  const take = (chosen: (feed: Feed, connection: Connection) => boolean) =>
    Effect.gen(function* () {
      const receivedAt = yield* DateTime.now
      const envelopes: Array<IngestUp> = []
      const base = { protocolVersion: IngestProtocolVersion, receivedAt }
      for (const [connection, frames] of stockbit) {
        if (!chosen("Stockbit", connection)) continue
        envelopes.push({
          _tag: "Frames",
          ...base,
          feed: "Stockbit",
          connection,
          frames,
        })
        stockbit.delete(connection)
      }
      const kept = ajaib.filter((bucket) => {
        const { connection, stream, frames } = bucket
        if (!chosen("Ajaib", connection)) return true
        envelopes.push({
          _tag: "Frames",
          ...base,
          feed: "Ajaib",
          stream,
          connection,
          frames,
        })
        return false
      })
      ajaib.splice(0, ajaib.length, ...kept)
      return envelopes
    })

  // The envelopes for every connection that received frames since the last
  // flush.
  const flush = take(() => true)

  // The envelopes of one connection's frames, every stream of it.
  const drain = (feed: Feed, connection: Connection) =>
    take((held, of) => held === feed && of === connection)

  return { add, flush, drain }
})
