// An in-memory shareholding archive bucket. `puts` logs every write in order,
// so a test can tell a rewrite from an untouched object.
import { Effect, Layer } from "effect"

import { ArchiveBucket } from "@/server/shareholding/bucket"

export interface StoredObject {
  readonly body: string
  readonly contentType: string
  readonly customMetadata: Readonly<Record<string, string>>
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
          Effect.sync(() =>
            [...objects]
              .filter(([key]) => key.startsWith(prefix))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, object]) => ({
                key,
                size: object.body.length,
                customMetadata: object.customMetadata,
              }))
          ),
        exists: (key) => Effect.sync(() => objects.has(key)),
        get: (key) => Effect.sync(() => objects.get(key)?.body),
        put: (key, body, { contentType, customMetadata = {} }) =>
          Effect.sync(() => {
            puts.push(key)
            objects.set(key, {
              body:
                typeof body === "string"
                  ? body
                  : new TextDecoder().decode(body),
              contentType,
              customMetadata,
            })
          }),
      })
    ),
  }
}
