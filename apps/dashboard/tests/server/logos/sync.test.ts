import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

import { logoKey, logoUrl, syncLogos } from "@/server/logos/sync"

import { memoryBucket } from "../archive/memory-bucket"

// A PNG's first eight bytes, then a body.
const png = (fill: number) =>
  new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, fill, fill, fill])

interface FakeLogo {
  readonly body: Uint8Array<ArrayBuffer> | string
  readonly etag?: string
  // Answered instead of the file, when set.
  readonly status?: number
  // Ignores If-None-Match, as a CDN may.
  readonly unconditional?: boolean
}

// Stockbit's logo CDN: one file per code's URL, 403 for a code it has none
// for, as the CDN answers. It answers 304 to a matching If-None-Match.
// `inFlight` peaks above 1 only if two requests overlap.
const fakeStockbit = (logos: Map<string, FakeLogo>) => {
  const cdn = {
    requests: new Array<string>(),
    inFlight: 0,
    peak: 0,
    layer: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.gen(function* () {
          cdn.requests.push(url.href)
          cdn.inFlight++
          cdn.peak = Math.max(cdn.peak, cdn.inFlight)
          yield* Effect.yieldNow
          cdn.inFlight--
          const logo = logos.get(url.href)
          const sent = request.headers["if-none-match"]
          const answer =
            logo === undefined
              ? new Response("Forbidden", { status: 403 })
              : logo.status !== undefined
                ? new Response("CDN error", { status: logo.status })
                : logo.unconditional !== true &&
                    sent !== undefined &&
                    sent === logo.etag
                  ? new Response(null, { status: 304 })
                  : new Response(logo.body, {
                      headers: {
                        "content-type": "image/png",
                        ...(logo.etag === undefined ? {} : { etag: logo.etag }),
                      },
                    })
          return HttpClientResponse.fromWeb(request, answer)
        })
      )
    ),
  }
  return cdn
}

const codes = (...names: Array<string>) =>
  names.map((name) => StockCode.make(name))

describe("the logo sync", () => {
  it.effect(
    "copies each code's logo with its source ETag, one request at a time",
    () =>
      Effect.gen(function* () {
        const bucket = memoryBucket()
        const cdn = fakeStockbit(
          new Map([
            [logoUrl("BBCA"), { body: png(1), etag: '"bbca-1"' }],
            [logoUrl("TLKM"), { body: png(2), etag: '"tlkm-1"' }],
          ])
        )

        const synced = yield* syncLogos(codes("BBCA", "TLKM", "NOPE")).pipe(
          Effect.provide(Layer.merge(bucket.layer, cdn.layer))
        )

        assert.deepStrictEqual(synced, {
          written: 2,
          unchanged: 0,
          missing: 1,
          failed: 0,
        })
        assert.strictEqual(cdn.peak, 1)
        const bbca = bucket.objects.get(logoKey("BBCA"))
        assert.deepStrictEqual(bbca?.bytes, png(1))
        assert.strictEqual(bbca?.contentType, "image/png")
        assert.deepStrictEqual(bbca?.customMetadata, {
          "source-etag": '"bbca-1"',
        })
        assert.isFalse(bucket.objects.has(logoKey("NOPE")))
      })
  )

  it.effect("skips a file whose source ETag hasn't changed", () =>
    Effect.gen(function* () {
      const bucket = memoryBucket()
      const logos = new Map<string, FakeLogo>([
        [logoUrl("BBCA"), { body: png(1), etag: '"bbca-1"' }],
        [
          logoUrl("TLKM"),
          { body: png(2), etag: '"tlkm-1"', unconditional: true },
        ],
      ])
      const cdn = fakeStockbit(logos)
      const layer = Layer.merge(bucket.layer, cdn.layer)
      yield* syncLogos(codes("BBCA", "TLKM")).pipe(Effect.provide(layer))
      bucket.puts.length = 0

      const again = yield* syncLogos(codes("BBCA", "TLKM")).pipe(
        Effect.provide(layer)
      )

      assert.deepStrictEqual(again, {
        written: 0,
        unchanged: 2,
        missing: 0,
        failed: 0,
      })
      assert.deepStrictEqual(bucket.puts, [])

      // A new file at the source is copied over the old one.
      logos.set(logoUrl("BBCA"), { body: png(3), etag: '"bbca-2"' })
      yield* syncLogos(codes("BBCA", "TLKM")).pipe(Effect.provide(layer))
      assert.deepStrictEqual(bucket.puts, [logoKey("BBCA")])
      assert.deepStrictEqual(bucket.objects.get(logoKey("BBCA"))?.bytes, png(3))
    })
  )

  it.effect("keeps a good file when its download fails", () =>
    Effect.gen(function* () {
      const bucket = memoryBucket()
      const logos = new Map<string, FakeLogo>([
        [logoUrl("BBCA"), { body: png(1), etag: '"bbca-1"' }],
        [logoUrl("TLKM"), { body: png(2), etag: '"tlkm-1"' }],
        [logoUrl("ASII"), { body: png(4), etag: '"asii-1"' }],
        [logoUrl("BMRI"), { body: png(5), etag: '"bmri-1"' }],
      ])
      const cdn = fakeStockbit(logos)
      const layer = Layer.merge(bucket.layer, cdn.layer)
      yield* syncLogos(codes("BBCA", "TLKM", "ASII", "BMRI")).pipe(
        Effect.provide(layer)
      )
      bucket.puts.length = 0

      // A server error, a code the CDN no longer has, an error page sent as
      // a 200, and an empty 200.
      logos.set(logoUrl("BBCA"), { body: png(9), status: 503 })
      logos.delete(logoUrl("TLKM"))
      logos.set(logoUrl("ASII"), { body: "<html>Busy</html>", etag: '"x"' })
      logos.set(logoUrl("BMRI"), { body: new Uint8Array(), etag: '"y"' })
      const failed = yield* syncLogos(
        codes("BBCA", "TLKM", "ASII", "BMRI")
      ).pipe(Effect.provide(layer))

      assert.deepStrictEqual(failed, {
        written: 0,
        unchanged: 0,
        missing: 1,
        failed: 3,
      })
      assert.deepStrictEqual(bucket.puts, [])
      assert.deepStrictEqual(bucket.objects.get(logoKey("BBCA"))?.bytes, png(1))
      assert.deepStrictEqual(bucket.objects.get(logoKey("TLKM"))?.bytes, png(2))
      assert.deepStrictEqual(bucket.objects.get(logoKey("ASII"))?.bytes, png(4))
      assert.deepStrictEqual(bucket.objects.get(logoKey("BMRI"))?.bytes, png(5))
    })
  )

  it.effect("goes on to the next code past a failed write", () =>
    Effect.gen(function* () {
      const bucket = memoryBucket()
      const cdn = fakeStockbit(
        new Map([
          [logoUrl("BBCA"), { body: png(1), etag: '"bbca-1"' }],
          [logoUrl("TLKM"), { body: png(2), etag: '"tlkm-1"' }],
        ])
      )
      bucket.failPut = (key) => key === logoKey("BBCA")

      const synced = yield* syncLogos(codes("BBCA", "TLKM")).pipe(
        Effect.provide(Layer.merge(bucket.layer, cdn.layer))
      )

      assert.deepStrictEqual(synced, {
        written: 1,
        unchanged: 0,
        missing: 0,
        failed: 1,
      })
      assert.isTrue(bucket.objects.has(logoKey("TLKM")))
    })
  )
})
