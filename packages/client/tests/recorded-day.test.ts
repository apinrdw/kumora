// A recorded day's GETs against a Worker answering each status: only a 404
// means nothing was recorded; a failing Worker fails, so the page's caches
// never hold a failure as a missing chunk.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

import { fetchRecordedBookChunk } from "@workspace/client"

const DAY = WibDate.make("2026-11-09")
const BBCA = StockCode.make("BBCA")
const MINUTE = DateTime.makeUnsafe("2026-11-09T02:00:00Z")

// A Worker answering every GET with `status`; the relative path needs an
// origin outside a browser.
const worker = (status: number) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("Recorded day not served", { status })
      )
    )
  ).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl("http://dashboard.test"))
  )

const bookChunkFrom = (status: number) =>
  fetchRecordedBookChunk(DAY, BBCA, MINUTE).pipe(
    Effect.provideService(HttpClient.HttpClient, worker(status))
  )

describe("a recorded day's GETs", () => {
  it.effect("a 404 means the code had no book by then", () =>
    Effect.gen(function* () {
      const chunk = yield* bookChunkFrom(404)
      assert.isTrue(Option.isNone(chunk))
    })
  )

  it.effect("a 401 fails SignInRequired", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(bookChunkFrom(401))
      assert.strictEqual(error._tag, "SignInRequired")
    })
  )

  for (const status of [500, 503])
    it.effect(`a ${status} fails rather than answering no book`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(bookChunkFrom(status))
        assert.strictEqual(error._tag, "HttpClientError")
      })
    )
})
