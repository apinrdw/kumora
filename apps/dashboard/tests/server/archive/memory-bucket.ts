// An in-memory archive bucket. `puts` logs every write in order,
// so a test can tell a rewrite from an untouched object. An object's ETag is
// its body, so, as R2's MD5, it changes with the content. `failPut`, when
// set, fails the next `put` of a key it matches, once, as a transient R2
// error. `listed` logs every key a listing returned, `gets` every key read.
import { Clock, Effect, Layer } from "effect"

import {
  ArchiveBucket,
  BucketError,
  checkListed,
  type PutOptions,
} from "@/server/archive/bucket"

export interface StoredObject {
  readonly body: string
  // The bytes written, when they were bytes; `body` is their UTF-8 reading.
  readonly bytes?: Uint8Array | undefined
  readonly contentType: string
  readonly customMetadata: Readonly<Record<string, string>>
  // When it was written, in epoch ms; an object seeded without one lists as
  // written just now.
  readonly uploaded?: number | undefined
}

export interface MemoryBucket {
  readonly objects: Map<string, StoredObject>
  readonly puts: Array<string>
  readonly listed: Array<string>
  readonly gets: Array<string>
  failPut: ((key: string) => boolean) | undefined
  readonly layer: Layer.Layer<ArchiveBucket>
}

export const memoryBucket = (): MemoryBucket => {
  const objects = new Map<string, StoredObject>()
  const puts: Array<string> = []
  const listed: Array<string> = []
  const gets: Array<string> = []
  const write = (
    key: string,
    body: Uint8Array | string,
    { contentType, customMetadata = {} }: PutOptions,
    uploaded: number
  ) => {
    puts.push(key)
    objects.set(key, {
      body: typeof body === "string" ? body : new TextDecoder().decode(body),
      bytes: typeof body === "string" ? undefined : body,
      contentType,
      customMetadata,
      uploaded,
    })
  }
  const bucket: MemoryBucket = {
    objects,
    puts,
    listed,
    gets,
    failPut: undefined,
    layer: Layer.succeed(
      ArchiveBucket,
      ArchiveBucket.of({
        list: (prefix, { startAfter = "" } = {}) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const matching = [...objects]
              .filter(([key]) => key.startsWith(prefix) && key > startAfter)
              // In key order, as R2 lists.
              .sort(([a], [b]) => (a < b ? -1 : 1))
            yield* checkListed(prefix, matching.length)
            return matching.map(([key, object]) => {
              listed.push(key)
              return {
                key,
                size: object.body.length,
                uploaded: new Date(object.uploaded ?? now),
                customMetadata: object.customMetadata,
              }
            })
          }),
        exists: (key) => Effect.sync(() => objects.has(key)),
        get: (key) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            gets.push(key)
            const object = objects.get(key)
            return object === undefined
              ? undefined
              : {
                  body: object.body,
                  etag: object.body,
                  uploaded: new Date(object.uploaded ?? now),
                }
          }),
        getBytes: (key) =>
          Effect.sync(() => {
            gets.push(key)
            const object = objects.get(key)
            return object === undefined
              ? undefined
              : (object.bytes ?? new TextEncoder().encode(object.body))
          }),
        put: (key, body, options) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            if (bucket.failPut?.(key) === true) {
              bucket.failPut = undefined
              return Effect.fail(
                new BucketError({
                  operation: "put",
                  key,
                  cause: new Error("R2 is unavailable"),
                })
              )
            }
            write(key, body, options, now)
            return Effect.void
          }),
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
  return bucket
}
