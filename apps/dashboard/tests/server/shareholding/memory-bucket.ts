// An in-memory shareholding archive bucket. `puts` logs every write in order,
// so a test can tell a rewrite from an untouched object.
import { Clock, Effect, Layer } from "effect"

import { ArchiveBucket } from "@/server/shareholding/bucket"

export interface StoredObject {
  readonly body: string
  readonly contentType: string
  readonly customMetadata: Readonly<Record<string, string>>
  // When it was written, in epoch ms; an object seeded without one lists as
  // written just now.
  readonly uploaded?: number | undefined
}

export interface MemoryBucket {
  readonly objects: Map<string, StoredObject>
  readonly puts: Array<string>
  readonly layer: Layer.Layer<ArchiveBucket>
}

export const memoryBucket = (): MemoryBucket => {
  const objects = new Map<string, StoredObject>()
  const puts: Array<string> = []
  return {
    objects,
    puts,
    layer: Layer.succeed(
      ArchiveBucket,
      ArchiveBucket.of({
        list: (prefix) =>
          Effect.map(Clock.currentTimeMillis, (now) =>
            [...objects]
              .filter(([key]) => key.startsWith(prefix))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, object]) => ({
                key,
                size: object.body.length,
                uploaded: new Date(object.uploaded ?? now),
                customMetadata: object.customMetadata,
              }))
          ),
        exists: (key) => Effect.sync(() => objects.has(key)),
        get: (key) => Effect.sync(() => objects.get(key)?.body),
        put: (key, body, { contentType, customMetadata = {} }) =>
          Effect.map(Clock.currentTimeMillis, (uploaded) => {
            puts.push(key)
            objects.set(key, {
              body:
                typeof body === "string"
                  ? body
                  : new TextDecoder().decode(body),
              contentType,
              customMetadata,
              uploaded,
            })
          }),
      })
    ),
  }
}
