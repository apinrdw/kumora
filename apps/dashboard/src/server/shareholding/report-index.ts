// The shareholding archive's rows in the report index
// (../archive/report-index.ts): written by its run's `report:` steps, healed
// by its `plan`, read by the admin page for the totals (totals.ts) and the
// parse coverage.
import { Effect, Schema } from "effect"

import type { ListedObject } from "../archive/bucket.ts"
import {
  healIndex,
  type IndexedArchive,
  indexedReport,
  indexReports,
  newestIndexedVersions,
} from "../archive/report-index.ts"
import { reportKey } from "./keys.ts"
import { ReportKind } from "./listing.ts"

const isKind = Schema.is(ReportKind)

const SHAREHOLDING: IndexedArchive = {
  archive: "shareholding",
  fileKey: (kind, dataDate, sha256) =>
    isKind(kind) ? reportKey(kind, dataDate, sha256) : Effect.undefined,
}

// Indexes the record a `report:` step just wrote, unless the index has it.
export const indexShareholdingReport = Effect.fnUntraced(function* (
  recordKey: string,
  sizes: { readonly fileBytes: number; readonly recordBytes: number }
) {
  const report = yield* indexedReport(SHAREHOLDING, recordKey, sizes)
  if (report !== undefined) yield* indexReports(SHAREHOLDING.archive, [report])
})

// Indexes every record in `objects`, a listing of reports/, the index lacks.
export const healShareholdingIndex = (objects: ReadonlyArray<ListedObject>) =>
  healIndex(SHAREHOLDING, objects)

// Each archived date of `kind`, oldest first, with its newest version's
// SHA-256.
export const shareholdingNewestVersions = (kind: ReportKind) =>
  newestIndexedVersions(SHAREHOLDING.archive, kind)
