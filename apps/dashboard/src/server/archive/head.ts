// An archive run's `head` step: a HEAD to each held file, to find the ones
// whose ETag no record has. Each archive names a held file by its own
// identity (the shareholding archive's source URL, the KSEI archive's
// filename) and says which URL to ask.
import { jsonBytes } from "@workspace/server"
import { Effect, Result } from "effect"
import { HttpClient } from "effect/http"

import type { HeldRecords } from "./held.ts"

export interface HeldFile {
  // What the archive's records name the file by.
  readonly key: string
  // Where to send its HEAD.
  readonly url: string
}

export interface HeadResult {
  // How many held files answered their HEAD.
  readonly checked: number
  // Held files whose ETag no record has, with the ETag their HEAD answered.
  readonly changed: ReadonlyArray<{
    readonly key: string
    readonly etag: string
  }>
  // Held files whose HEAD failed.
  readonly unanswered: ReadonlyArray<string>
}

// The most bytes an ETag a run keeps may take as JSON, in a step's result
// and a record. IDX's are like "03a76c15973dd1:0"; KSEI's are a quoted MD5,
// 34.
export const MAX_ETAG_BYTES = 64

// Concurrent HEADs to a source, kept modest out of courtesy to it.
const HEAD_CONCURRENCY = 4

// An ETag as compared: `W/"x"` (weak, as a HEAD may answer) and `"x"` are
// the same file.
export const comparableEtag = (etag: string) =>
  Effect.sync(() => etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1"))

// A HEAD to every held file. A response with no ETag can't show a change, so
// its file counts as unchanged. A failed HEAD (a status other than 2xx
// included) doesn't fail the step: its file is recorded, and the next run
// checks it again. So is one whose ETag is over MAX_ETAG_BYTES as JSON,
// which the step's result couldn't carry. `records` are what heldRecords
// (held.ts) read.
export const headHeld = Effect.fnUntraced(function* (
  held: ReadonlyArray<HeldFile>,
  records: ReadonlyMap<string, HeldRecords>
): Effect.fn.Return<HeadResult, never, HttpClient.HttpClient> {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const answers = yield* Effect.forEach(
    held,
    ({ key, url }) =>
      client.head(url).pipe(
        Effect.flatMap(
          Effect.fnUntraced(function* (response) {
            const etag = response.headers["etag"]
            if (etag === undefined) return { key, etag, changed: false }
            if ((yield* jsonBytes(etag)) > MAX_ETAG_BYTES)
              return yield* Effect.fail(etag)
            const seen = yield* Effect.forEach(
              records.get(key)?.etags ?? [],
              comparableEtag
            )
            return {
              key,
              etag,
              changed: !seen.includes(yield* comparableEtag(etag)),
            }
          })
        ),
        Effect.mapError(() => key),
        Effect.result
      ),
    { concurrency: HEAD_CONCURRENCY }
  )
  const answered = answers
    .filter(Result.isSuccess)
    .map(({ success }) => success)
  return {
    checked: answered.length,
    changed: answered.flatMap(({ key, etag, changed }) =>
      changed && etag !== undefined ? [{ key, etag }] : []
    ),
    unanswered: answers.filter(Result.isFailure).map(({ failure }) => failure),
  }
})
