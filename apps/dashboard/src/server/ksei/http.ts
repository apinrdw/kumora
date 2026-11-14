// How the KSEI archive calls ksei.co.id: fetch, with the options every
// request carries. docs/research/ksei-statistik-kepemilikan-listing.md has
// how KSEI answers.
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"

// Decision: every request to KSEI is `cache: "no-store"`: from a Worker,
// repeat requests came back in milliseconds, apparently from Cloudflare's
// cache, which would hide a republished file. And `redirect: "manual"`: a
// missing file answers `302 Location: /id`, which fetch would follow to the
// home page's 200. See apinrdw/kumora#319 and #320.
export const kseiHttp = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, {
      cache: "no-store",
      redirect: "manual",
    })
  )
)
