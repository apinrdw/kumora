// The recorded days bucket (cold-days.ts) in memory: `objects` holds each
// key's stored bytes, and a key in `refused` fails its put, as R2 down.
import { gunzipSync } from "node:zlib"

import { Effect } from "effect"

import type { DayBucket } from "@/server/market-live/cold-days"

export const memoryDayBucket = () => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>()
  const refused = new Set<string>()
  const bucket: DayBucket = {
    put: (key, body) =>
      Effect.runPromise(
        refused.has(key)
          ? Effect.die(new Error("R2 is unavailable"))
          : Effect.sync(() => {
              objects.set(
                key,
                typeof body === "string"
                  ? new TextEncoder().encode(body)
                  : body.slice()
              )
            })
      ),
    // A range past the object's end is cut to it, as R2 does.
    get: (key, options) =>
      Effect.runPromise(
        Effect.sync(() => {
          const stored = objects.get(key)
          if (stored === undefined) return null
          const range = options?.range
          const bytes =
            range === undefined
              ? stored
              : stored.slice(range.offset, range.offset + range.length)
          return { body: new Response(bytes).body! }
        })
      ),
  }
  // A key's stored text, gunzipped when `gzipped`.
  const text = (key: string, gzipped = false) => {
    const stored = objects.get(key)
    if (stored === undefined) return undefined
    return new TextDecoder().decode(gzipped ? gunzipSync(stored) : stored)
  }
  return { bucket, objects, refused, text }
}
