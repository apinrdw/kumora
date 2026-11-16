// The logo sync (spec apinrdw/kumora#427, "Logos"): copies Stockbit's logo
// for every stock code into the logo bucket, which /logos/{CODE} serves
// (serve.ts). The logo cron runs it weekly, on Production only (cron.ts).
// Decision: Stockbit's logos, though its terms allow personal, non-commercial
// use only and forbid bulk extraction and retransmission without written
// consent. The owner accepted that risk on 2026-11-16. If Stockbit objects,
// swap in Logo.dev's licensed storage API, which covered 97 of the top 100
// codes and 907 of 944 (docs/research/idx-company-logos.md, apinrdw/kumora#416).
import type { StockCode } from "@workspace/relay"
import { Duration, Effect } from "effect"
import { HttpClient } from "effect/http"

import { collectCapped } from "../archive/capped-body.ts"
import { ArchiveBucket } from "../archive/bucket.ts"

export const logoUrl = (code: StockCode) =>
  Effect.sync(() => `https://assets.stockbit.com/logos/companies/${code}.png`)

const PREFIX = "logos/"

export const logoKey = (code: StockCode) =>
  Effect.sync(() => `${PREFIX}${code}.png`)

// The custom metadata key of the source's ETag.
const SOURCE_ETAG = "source-etag"

// Stockbit's files are 160 px PNGs, 5.1 KB at the median.
const MAX_LOGO_BYTES = 512 * 1024

// R2 caps an object's custom metadata at 2 KB; an ETag past this isn't kept,
// so the file is copied again next run.
const MAX_ETAG_LENGTH = 256

// One download at most this long, so a stuck request can't hold the run.
const REQUEST_TIMEOUT = Duration.seconds(10)

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

type Outcome = "written" | "unchanged" | "missing" | "failed"

const isPng = (bytes: Uint8Array) =>
  Effect.sync(
    () =>
      bytes.length > PNG_SIGNATURE.length &&
      PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  )

// One code's logo: its file copied when the source's ETag differs from the
// stored one. Anything short of a PNG leaves the stored file as it was.
const syncLogo = Effect.fnUntraced(function* (
  code: StockCode,
  held: string | undefined
) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .get(yield* logoUrl(code), {
      headers: held === undefined ? {} : { "if-none-match": held },
    })
    .pipe(Effect.timeout(REQUEST_TIMEOUT))
  if (response.status === 304) return "unchanged" satisfies Outcome
  // Stockbit answers 403 for a code it has no logo for.
  if (response.status === 403 || response.status === 404)
    return "missing" satisfies Outcome
  if (response.status !== 200) return "failed" satisfies Outcome
  const etag = response.headers["etag"]
  if (etag !== undefined && etag === held) return "unchanged" satisfies Outcome
  const bytes = yield* collectCapped(
    response.stream,
    MAX_LOGO_BYTES,
    () => new Error(`${code}'s logo is over ${MAX_LOGO_BYTES} bytes`)
  ).pipe(Effect.timeout(REQUEST_TIMEOUT))
  if (!(yield* isPng(bytes))) return "failed" satisfies Outcome
  yield* (yield* ArchiveBucket).put(yield* logoKey(code), bytes, {
    contentType: "image/png",
    customMetadata:
      etag === undefined || etag.length > MAX_ETAG_LENGTH
        ? {}
        : { [SOURCE_ETAG]: etag },
  })
  return "written" satisfies Outcome
})

// Every code of `codes`, one request at a time. A code that fails is
// counted and the run goes on; next week's run tries it again.
export const syncLogos = Effect.fn("syncLogos")(function* (
  codes: ReadonlyArray<StockCode>
) {
  // A listing past MAX_LISTED_OBJECTS fails (../archive/bucket.ts), so the
  // ETags held stay bounded.
  const stored = yield* (yield* ArchiveBucket).list(PREFIX)
  const held = new Map(
    stored.map((object) => [object.key, object.customMetadata[SOURCE_ETAG]])
  )
  const tally: Record<Outcome, number> = {
    written: 0,
    unchanged: 0,
    missing: 0,
    failed: 0,
  }
  for (const code of codes) {
    const outcome = yield* syncLogo(code, held.get(yield* logoKey(code))).pipe(
      Effect.catch(() => Effect.succeed<Outcome>("failed"))
    )
    tally[outcome]++
  }
  yield* Effect.logInfo("Logos synced").pipe(
    Effect.annotateLogs({ codes: codes.length, ...tally })
  )
  return tally
})
