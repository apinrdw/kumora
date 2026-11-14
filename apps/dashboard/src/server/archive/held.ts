// What an archive holds, read from its records' custom metadata under
// reports/: each record names its file by the archive's own identity (the
// `identity` metadata key: the shareholding archive's source URL, the KSEI
// archive's filename), the ETag it was stored under, its SHA-256 and the run
// that wrote it.
import { Effect } from "effect"

import { ArchiveBucket } from "./bucket.ts"
import { type ArchiveRunId, REPORTS_PREFIX } from "./run.ts"

// The record metadata keys every archive writes besides its identity. RUN
// names the run that wrote it, so `summary` can tell its own records from
// earlier ones.
export const ETAG = "etag"
export const SHA256 = "sha256"
export const RUN = "run"

export interface HeldRecords {
  readonly etags: Array<string>
  readonly sha256s: Array<string>
}

// The ETags and hashes the records of each held file hold, by identity,
// leaving out those `run` wrote.
// Decision: `plan`, `head` and `summary` each list reports/ with custom
// metadata, not `plan` alone as the spec says: carried between steps, it
// would outgrow a step result. ~150 files and records on 2026-11-14, ~50
// more a month. A per-URL lookup costs a request per listed report. See
// apinrdw/kumora#303 and #305.
export const heldRecords = Effect.fnUntraced(function* (
  identity: string,
  run?: ArchiveRunId
) {
  const held = new Map<string, HeldRecords>()
  for (const { customMetadata } of yield* (yield* ArchiveBucket).list(
    REPORTS_PREFIX
  )) {
    const key = customMetadata[identity]
    if (key === undefined || (run !== undefined && customMetadata[RUN] === run))
      continue
    const records = held.get(key) ?? { etags: [], sha256s: [] }
    const etag = customMetadata[ETAG]
    if (etag !== undefined) records.etags.push(etag)
    const sha256 = customMetadata[SHA256]
    if (sha256 !== undefined) records.sha256s.push(sha256)
    held.set(key, records)
  }
  return held
})
