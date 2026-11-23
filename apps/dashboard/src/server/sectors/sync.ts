// The daily sector run (spec apinrdw/kumora#427, "Sectors"): IDX's company
// profiles, one GET for every listed stock, replace the stock_sector table
// in HoldingsDb in one batch. docs/research/idx-sector-classification.md has
// the endpoint's behaviour.
import { Sector, StockCode } from "@workspace/relay"
import { NonRetryable } from "@workspace/server"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"

import { readCappedJson } from "../archive/capped-body.ts"
import { HoldingsDb } from "../holdings/db.ts"
import { monthRows } from "../holdings/month-replace.ts"

// Every stock in one call, with English names.
export const PROFILES_URL =
  "https://www.idx.id/primary/ListedCompany/GetCompanyProfiles?emitenType=s&start=0&length=9999&lang=en"

// At most 5,000 profiles, about 5× the 944 IDX listed on
// 2026-11-16, so the table, and the map the dashboard serves from it
// (map.ts), stay bounded. A profile took about 915 bytes of JSON with its
// contact fields, so 8 MB holds the most with room for new fields.
export const MAX_PROFILES = 5_000
const MAX_PROFILES_BYTES = 8_000_000

// A run that reads fewer than this share of the rows stored keeps them.
const MIN_KEPT_SHARE = 0.9

// Only the four levels: the record's contact fields are never kept.
const Profiles = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      KodeEmiten: Schema.String,
      Sektor: Schema.String,
      SubSektor: Schema.String,
      Industri: Schema.String,
      SubIndustri: Schema.String,
    })
  ),
})

export type SectorRun =
  | {
      readonly _tag: "Replaced"
      readonly rows: number
      // Each profile left out, as `CODE (why)`.
      readonly skipped: ReadonlyArray<string>
    }
  // A sanity gate dropped the run; yesterday's table stays.
  | { readonly _tag: "Kept"; readonly reason: string }

// A run as the cron and Run now record it: IDX failing is an outcome too.
export type RecordedSectorRun =
  | SectorRun
  | { readonly _tag: "Failed"; readonly message: string }

const isSector = Schema.is(Sector)
const isStockCode = Schema.is(StockCode)

const fetchProfiles = Effect.gen(function* () {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  return yield* client.get(PROFILES_URL).pipe(
    Effect.flatMap((response) =>
      readCappedJson(response, MAX_PROFILES_BYTES, "IDX's company profiles")
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(Profiles)),
    Effect.catchTags({
      HttpClientError: ({ reason }) =>
        Effect.fail(
          new NonRetryable({
            message:
              reason._tag === "StatusCodeError"
                ? `IDX's company profiles answered ${reason.response.status} (${PROFILES_URL})`
                : `IDX's company profiles couldn't be read: ${reason.message}`,
          })
        ),
      SchemaError: (error) =>
        Effect.fail(
          new NonRetryable({
            message: `IDX's company profiles no longer match their Schema: ${error.message}`,
          })
        ),
    })
  )
})

// The rows the profiles give, trimmed, or why the run keeps the table.
const rowsOf = Effect.fnUntraced(function* (
  profiles: typeof Profiles.Type,
  stored: number
) {
  const { data } = profiles
  if (data.length > MAX_PROFILES)
    return yield* new NonRetryable({
      message: `IDX lists ${data.length.toLocaleString("en-US")} company profiles, more than the ${MAX_PROFILES.toLocaleString("en-US")} the sector table holds`,
    })
  const rows = new Array<readonly [StockCode, Sector, string, string, string]>()
  const skipped = new Array<string>()
  for (const profile of data) {
    const code = profile.KodeEmiten.trim()
    const sector = profile.Sektor.trim()
    // A code the table can't key leaves its profile out, not the run.
    if (!isStockCode(code)) {
      skipped.push(`"${code}" (no stock code)`)
      continue
    }
    // A profile IDX still files under a JASICA sector (AGII on
    // 2026-11-18) leaves the table, so its code shows as Unclassified; the
    // 90 % gate below still keeps the table when many go at once.
    if (!isSector(sector)) {
      skipped.push(`${code} (${sector})`)
      continue
    }
    rows.push([
      code,
      sector,
      profile.SubSektor.trim(),
      profile.Industri.trim(),
      profile.SubIndustri.trim(),
    ])
  }
  if (skipped.length > 0)
    yield* Effect.logWarning("Sector run skipped profiles", { skipped })
  // An empty table has no 90 % to fall under, so a run that keeps nothing
  // is refused outright.
  if (rows.length === 0 || rows.length < stored * MIN_KEPT_SHARE)
    return {
      _tag: "Kept",
      reason: `IDX lists ${rows.length} company profiles with a stock code and an IDX-IC sector, under 90 % of the ${stored} stored`,
    } as const
  return { _tag: "Rows", rows, skipped } as const
})

const COLUMNS = ["code", "sector", "sub_sector", "industry", "sub_industry"]

// Every row out and the run's in, in one batch, which D1 runs as one
// transaction: a reader sees yesterday's table or today's, never a mix.
const replaceTable = Effect.fnUntraced(function* (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  fetchedAt: Date
) {
  const gathered = yield* monthRows("stock_sector", COLUMNS)
  for (const row of rows) yield* gathered.add(row)
  const { chunks } = yield* gathered.gathered
  yield* (yield* HoldingsDb).batch([
    { sql: "DELETE FROM stock_sector", params: [] },
    ...chunks.map((chunk) => ({
      sql:
        `INSERT INTO stock_sector (${COLUMNS.join(", ")}, fetched_at) ` +
        `SELECT ${COLUMNS.map((_, index) => `value->>${index}`).join(", ")}, ? ` +
        "FROM json_each(?)",
      params: [fetchedAt.toISOString(), chunk],
    })),
  ])
})

export const syncSectors = Effect.fn("syncSectors")(function* (
  fetchedAt: Date
) {
  const db = yield* HoldingsDb
  const [[count]] = yield* db.batch([
    { sql: "SELECT count(*) AS stored FROM stock_sector", params: [] },
  ])
  const stored = Number(count?.stored ?? 0)
  const read = yield* rowsOf(yield* fetchProfiles, stored)
  if (read._tag === "Kept") {
    yield* Effect.logWarning("Sector run kept yesterday's table", {
      reason: read.reason,
    })
    const kept: SectorRun = { _tag: "Kept", reason: read.reason }
    return kept
  }
  yield* replaceTable(read.rows, fetchedAt)
  yield* Effect.logInfo("Sector run replaced the table", {
    rows: read.rows.length,
  })
  const replaced: SectorRun = {
    _tag: "Replaced",
    rows: read.rows.length,
    skipped: read.skipped,
  }
  return replaced
})

// The run, with its outcome kept in sector_run for the Sectors card. A
// NonRetryable is IDX failing, so it becomes Failed rather than an error.
export const recordedSectorRun = Effect.fn("recordedSectorRun")(function* (
  ranAt: Date
) {
  const run = yield* syncSectors(ranAt).pipe(
    Effect.map((outcome): RecordedSectorRun => outcome),
    Effect.catchTag("NonRetryable", ({ message }) =>
      Effect.logWarning("Sector run failed", { message }).pipe(
        Effect.as<RecordedSectorRun>({ _tag: "Failed", message })
      )
    )
  )
  yield* (yield* HoldingsDb).batch([
    {
      sql:
        "INSERT OR REPLACE INTO sector_run (id, outcome, rows, skipped, message, ran_at) " +
        "VALUES (1, ?, ?, ?, ?, ?)",
      params: [
        run._tag,
        run._tag === "Replaced" ? run.rows : null,
        run._tag === "Replaced" ? JSON.stringify(run.skipped) : null,
        run._tag === "Kept"
          ? run.reason
          : run._tag === "Failed"
            ? run.message
            : null,
        ranAt.toISOString(),
      ],
    },
  ])
  return run
})
