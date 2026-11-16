import { assert, describe, it } from "@effect/vitest"
import { WorkerEnv } from "@workspace/server"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { logoResponse } from "@/server/logos/serve"
import { logoKey } from "@/server/logos/sync"

const BBCA = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])

// The logo bucket's R2 binding, holding BBCA's logo. `reads` logs each key
// read.
const logoBucket = () => {
  const reads: Array<string> = []
  const binding = {
    get: (key: string) =>
      Effect.runPromise(
        Effect.sync(() => {
          reads.push(key)
          return key === logoKey(StockCode.make("BBCA"))
            ? { body: new Response(BBCA).body!, httpEtag: '"r2-bbca"' }
            : null
        })
      ),
  }
  return {
    reads,
    env: { LOGO_BUCKET: binding } as unknown as WorkerEnv["Service"],
  }
}

const answer = (code: string, ifNoneMatch: string | null = null) => {
  const bucket = logoBucket()
  return logoResponse(code, ifNoneMatch).pipe(
    Effect.provideService(WorkerEnv, bucket.env),
    Effect.map((response) => ({ response, reads: bucket.reads }))
  )
}

const CACHE = "public, max-age=86400, stale-while-revalidate=604800"

describe("a logo request", () => {
  it.effect("streams the code's logo with its cache headers and ETag", () =>
    Effect.gen(function* () {
      const { response } = yield* answer("BBCA")

      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers.get("content-type"), "image/png")
      assert.strictEqual(response.headers.get("cache-control"), CACHE)
      assert.strictEqual(response.headers.get("etag"), '"r2-bbca"')
      const body = yield* Effect.promise(() => response.arrayBuffer())
      assert.deepStrictEqual(new Uint8Array(body), BBCA)
    })
  )

  it.effect("answers 304 to the ETag the browser holds", () =>
    Effect.gen(function* () {
      const { response } = yield* answer("BBCA", '"r2-bbca"')

      assert.strictEqual(response.status, 304)
      assert.strictEqual(response.headers.get("etag"), '"r2-bbca"')
      assert.strictEqual(response.headers.get("cache-control"), CACHE)
    })
  )

  it.effect("answers 404 for a code with no logo", () =>
    Effect.gen(function* () {
      const { response } = yield* answer("TLKM")

      assert.strictEqual(response.status, 404)
    })
  )

  it.effect("answers 404 without reading the bucket for a non-code", () =>
    Effect.gen(function* () {
      const { response, reads } = yield* answer("../auth/x")

      assert.strictEqual(response.status, 404)
      assert.deepStrictEqual(reads, [])
    })
  )
})
