// How the disclosure run calls www.idx.id: fetch, with a timeout on every
// request, so a stuck one fails within its step rather than taking the
// step's whole timeout.
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http"

// A request www.idx.id hasn't answered in a minute fails. A listing page of
// 500 disclosures and a file of a few MB answer in seconds.
export const IDX_REQUEST_TIMEOUT = "1 minute"

// `cache: "no-store"`, as the KSEI archive's requests (../ksei/http.ts): a
// listing read again must be IDX's answer now, never Cloudflare's copy.
const fetchLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store" })
  )
)

export const disclosureHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    return HttpClient.transform(
      yield* HttpClient.HttpClient,
      (response, request) =>
        Effect.timeoutOrElse(response, {
          duration: IDX_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: `IDX didn't answer in ${IDX_REQUEST_TIMEOUT}`,
                }),
              })
            ),
        })
    )
  })
).pipe(Layer.provide(fetchLayer))
