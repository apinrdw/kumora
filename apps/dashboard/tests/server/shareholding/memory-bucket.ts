// An in-memory shareholding archive bucket. `puts` logs every write in order,
// so a test can tell a rewrite from an untouched object. An object's ETag is
// its body, so, as R2's MD5, it changes with the content.
import { Clock, Effect, Layer } from "effect"

import { ArchiveBucket, type PutOptions } from "@/server/shareholding/bucket"

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
  const write = (
    key: string,
    body: Uint8Array | string,
    { contentType, customMetadata = {} }: PutOptions,
    uploaded: number
  ) => {
    puts.push(key)
    objects.set(key, {
      body: typeof body === "string" ? body : new TextDecoder().decode(body),
      contentType,
      customMetadata,
      uploaded,
    })
  }
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
        get: (key) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            const object = objects.get(key)
            return object === undefined
              ? undefined
              : {
                  body: object.body,
                  etag: object.body,
                  uploaded: new Date(object.uploaded ?? now),
                }
          }),
        put: (key, body, options) =>
          Effect.map(Clock.currentTimeMillis, (now) =>
            write(key, body, options, now)
          ),
        // The check and the write in one operation, so no fiber runs
        // between them.
        putIfUnchanged: (key, body, options, etag) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            if (objects.get(key)?.body !== etag) return false
            write(key, body, options, now)
            return true
          }),
      })
    ),
  }
}
