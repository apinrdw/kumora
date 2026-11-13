// The relay's ingest token check: the ingest socket's first message
// (trading-day.ts) and the broker codes route's bearer (broker-codes-route.ts)
// both compare it against INGEST_TOKEN by sha256.
import { WorkerEnv } from "@workspace/server"
import { Effect } from "effect"

const sha256 = (text: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  ).pipe(Effect.map((digest) => new Uint8Array(digest).toString()))

export const ingestTokenMatches = Effect.fnUntraced(function* (token: string) {
  const { INGEST_TOKEN } = yield* WorkerEnv
  return (yield* sha256(token)) === (yield* sha256(INGEST_TOKEN))
})
