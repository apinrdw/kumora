// Frames gathered per connection and sent as one envelope per connection
// about every 250 ms (spec apinrdw/kumora#138, "Batching and targets").
import {
  IngestProtocolVersion,
  type Connection,
  type IngestUp,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

export const BATCH_INTERVAL = "250 millis"

// Ajaib's frames are JSON text. Stockbit's binary frames get their own
// buffers when its relay lands (apinrdw/kumora#155).
export const makeBatcher = Effect.fnUntraced(function* () {
  const buffers = new Map<Connection, Array<string>>()

  const add = Effect.fnUntraced(function* (
    connection: Connection,
    text: string
  ) {
    const buffer = buffers.get(connection)
    if (buffer === undefined) buffers.set(connection, [text])
    else buffer.push(text)
  })

  // The envelopes for every connection that received frames since the last
  // flush, stamped with the flush time.
  const flush = Effect.gen(function* () {
    const receivedAt = yield* DateTime.now
    const envelopes: Array<IngestUp> = []
    for (const [connection, frames] of buffers)
      envelopes.push({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Ajaib",
        connection,
        receivedAt,
        frames,
      })
    buffers.clear()
    return envelopes
  })

  return { add, flush }
})
