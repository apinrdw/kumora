// GET /logos/{CODE} (spec apinrdw/kumora#427, "Logos"): the code's logo from
// the logo bucket, which the logo sync fills (sync.ts). The route is
// src/routes/logos/$code.ts.
// Decision: served from the dashboard's own origin, so a canvas that draws a
// logo stays untainted and Market Bubbles' snapshot still exports. Open to
// anyone, like any image a page links: the cache is public. See
// apinrdw/kumora#432.
import { StockCode } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Schema } from "effect"

import { logoKey } from "./sync.ts"

const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800"

// The binding's members this route uses; R2Bucket meets this shape under
// Workers types, as bucket-r2.ts explains.
interface R2Binding {
  readonly get: (key: string) => Promise<{
    readonly body: ReadableStream
    readonly httpEtag: string
  } | null>
}

const isStockCode = Schema.is(StockCode)

const notFound = Effect.sync(() => new Response(null, { status: 404 }))

// `ifNoneMatch` is the request's If-None-Match header.
export const logoResponse = Effect.fn("logoResponse")(function* (
  code: string,
  ifNoneMatch: string | null
) {
  if (!isStockCode(code)) return yield* notFound
  const bucket: R2Binding = (yield* WorkerEnv).LOGO_BUCKET
  const key = yield* logoKey(code)
  const object = yield* Effect.promise(() => bucket.get(key))
  if (object === null) return yield* notFound
  const headers = { "cache-control": CACHE_CONTROL, etag: object.httpEtag }
  if (ifNoneMatch === object.httpEtag) {
    yield* Effect.promise(() => object.body.cancel())
    return new Response(null, { status: 304, headers })
  }
  return new Response(object.body, {
    headers: { ...headers, "content-type": "image/png" },
  })
})
