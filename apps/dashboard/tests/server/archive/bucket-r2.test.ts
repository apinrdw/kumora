import { assert, describe, it } from "@effect/vitest"
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer, Result, Stream } from "effect"

import {
  ArchiveBucket,
  MAX_LISTED_OBJECTS,
  PUT_PART_BYTES,
} from "@/server/archive/bucket"
import { archiveBucketR2 } from "@/server/shareholding/bindings"

// An R2 binding that lists `count` keys under reports/, 1000 to a page as R2
// does.
const listingOf = (count: number) => {
  const keys = Array.from(
    { length: count },
    (_, index) => `reports/above-5/${String(index).padStart(6, "0")}.json`
  )
  const binding = {
    list: ({ prefix, cursor }: { prefix: string; cursor?: string }) =>
      Effect.runPromise(
        Effect.sync(() => {
          const matching = keys.filter((key) => key.startsWith(prefix))
          const from = Number(cursor ?? 0)
          const page = matching.slice(from, from + 1000)
          const truncated = from + 1000 < matching.length
          return {
            objects: page.map((key) => ({
              key,
              size: 1,
              uploaded: new Date(0),
              customMetadata: {},
            })),
            truncated,
            ...(truncated ? { cursor: String(from + 1000) } : {}),
          }
        })
      ),
  }
  return archiveBucketR2.pipe(
    Layer.provide(
      Layer.succeed(WorkerEnv)({
        SHAREHOLDING_ARCHIVE_BUCKET: binding,
      } as unknown as WorkerEnv["Service"])
    )
  )
}

const list = (prefix: string) =>
  Effect.flatMap(ArchiveBucket, (bucket) => bucket.list(prefix))

describe("the R2 archive bucket", () => {
  it.effect("lists every page of the largest listing it accepts", () =>
    Effect.gen(function* () {
      const objects = yield* list("reports/").pipe(
        Effect.provide(listingOf(MAX_LISTED_OBJECTS))
      )
      assert.strictEqual(objects.length, MAX_LISTED_OBJECTS)
      assert.strictEqual(objects.at(-1)?.key, "reports/above-5/009999.json")
    })
  )

  it.effect("fails a listing past the largest it accepts", () =>
    Effect.gen(function* () {
      const listed = yield* Effect.result(
        list("reports/").pipe(Effect.provide(listingOf(MAX_LISTED_OBJECTS + 1)))
      )
      assert.isTrue(Result.isFailure(listed), "the listing failed")
      if (Result.isFailure(listed))
        assert.include(String(listed.failure.cause), String(MAX_LISTED_OBJECTS))
    })
  )
})

// An R2 binding that logs the writes putStream sends it, and the size of
// each part.
const writing = () => {
  const writes: Array<string> = []
  const parts: Array<number> = []
  const log = <A>(entry: string, value: A) =>
    Effect.runPromise(
      Effect.sync(() => {
        writes.push(entry)
        return value
      })
    )
  const binding = {
    put: (key: string, body: Uint8Array) =>
      log(`put ${key} ${body.length}`, {}),
    createMultipartUpload: (key: string) =>
      log(`create ${key}`, {
        uploadPart: (partNumber: number, value: Uint8Array) =>
          Effect.runPromise(
            Effect.sync(() => {
              parts.push(value.length)
              return { partNumber, etag: `e${partNumber}` }
            })
          ),
        complete: (uploaded: ReadonlyArray<{ partNumber: number }>) =>
          log(
            `complete ${uploaded.map(({ partNumber }) => partNumber).join(",")}`,
            {}
          ),
        abort: () => log("abort", undefined),
      }),
  }
  const layer = archiveBucketR2.pipe(
    Layer.provide(
      Layer.succeed(WorkerEnv)({
        SHAREHOLDING_ARCHIVE_BUCKET: binding,
      } as unknown as WorkerEnv["Service"])
    )
  )
  return { writes, parts, layer }
}

const MIB = 2 ** 20

// `size` bytes in chunks of 1 MiB, as a download streams in.
const bodyOf = (size: number) =>
  Stream.fromIterable(
    Array.from(
      { length: Math.ceil(size / MIB) },
      (_, index) => new Uint8Array(Math.min(MIB, size - index * MIB))
    )
  )

const putStream = <E>(body: Stream.Stream<Uint8Array, E>) =>
  Effect.flatMap(ArchiveBucket, (bucket) =>
    bucket.putStream("files/x.pdf", body, { contentType: "application/pdf" })
  )

describe("the R2 archive bucket's streamed put", () => {
  it.effect("writes a body within one part as one put", () =>
    Effect.gen(function* () {
      const { writes, layer } = writing()
      const size = yield* putStream(bodyOf(PUT_PART_BYTES)).pipe(
        Effect.provide(layer)
      )
      assert.strictEqual(size, PUT_PART_BYTES)
      assert.deepStrictEqual(writes, [`put files/x.pdf ${PUT_PART_BYTES}`])
    })
  )

  it.effect(
    "uploads a longer body in parts of one size, the last shorter",
    () =>
      Effect.gen(function* () {
        const { writes, parts, layer } = writing()
        const size = 2 * PUT_PART_BYTES + 3 * MIB
        assert.strictEqual(
          yield* putStream(bodyOf(size)).pipe(Effect.provide(layer)),
          size
        )
        assert.deepStrictEqual(writes, ["create files/x.pdf", "complete 1,2,3"])
        assert.deepStrictEqual(parts, [PUT_PART_BYTES, PUT_PART_BYTES, 3 * MIB])
      })
  )

  it.effect("aborts the upload when the body fails partway", () =>
    Effect.gen(function* () {
      const { writes, layer } = writing()
      const failed = yield* Effect.flip(
        putStream(
          Stream.concat(bodyOf(PUT_PART_BYTES + MIB), Stream.fail("reset"))
        ).pipe(Effect.provide(layer))
      )
      assert.strictEqual(failed, "reset")
      assert.deepStrictEqual(writes, ["create files/x.pdf", "abort"])
    })
  )
})
