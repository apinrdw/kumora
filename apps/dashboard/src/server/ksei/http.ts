// How the KSEI archive calls ksei.co.id: fetch, with the options every
// request carries. docs/research/ksei-statistik-kepemilikan-listing.md has
// how KSEI answers.
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http"

// The slowest KSEI answers a healthy request from a Worker: its first
// answer takes 6-8 s. See apinrdw/kumora#320.
export const KSEI_SLOWEST_ANSWER = "8 seconds"

// Decision: a request KSEI hasn't answered in 2 minutes fails, and the step
// that sent it decides what that means: `head` records its file unanswered,
// any other step retries. At 15 times KSEI's slowest answer, a request still
// waiting is stuck. See apinrdw/kumora#327, "Fetching from KSEI".
export const KSEI_REQUEST_TIMEOUT = "2 minutes"

// Decision: every request to KSEI is `cache: "no-store"`: from a Worker,
// repeat requests came back in milliseconds, apparently from Cloudflare's
// cache, which would hide a republished file. And `redirect: "manual"`: a
// missing file answers `302 Location: /id`, which fetch would follow to the
// home page's 200. See apinrdw/kumora#319 and #320.
const fetchLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, {
      cache: "no-store",
      redirect: "manual",
    })
  )
)

export const kseiHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    return HttpClient.transform(
      yield* HttpClient.HttpClient,
      (response, request) =>
        Effect.timeoutOrElse(response, {
          duration: KSEI_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: `KSEI didn't answer in ${KSEI_REQUEST_TIMEOUT}`,
                }),
              })
            ),
        })
    )
  })
).pipe(Layer.provide(fetchLayer))
