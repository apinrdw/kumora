// The daily Special Monitoring Board run (spec apinrdw/kumora#517, "Ticks,
// limits and excluded codes"): IDX's special-notation list, one GET for
// every code with a notation, keeps the codes whose notation includes X and
// replaces the special_board table in HoldingsDb in one batch.
// docs/research/idx-board-ticks-limits.md has the endpoint's behaviour.
import { StockCode } from "@workspace/relay"
import { NonRetryable } from "@workspace/server"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"

import { readCappedJson } from "../archive/capped-body.ts"
import { HoldingsDb } from "../holdings/db.ts"

// Every code with a notation, in English.
// Decision: not GetCompanyProfiles' listing board, which still named BRRC on
// 2026-11-18, 21 months after it left the board. See apinrdw/kumora#488.
export const SPECIAL_NOTATION_URL =
  "https://www.idx.id/secondary/get/ListedCompanies/SpecialNotation/SpecialNotation?Language=en-us&indexFrom=1&pageSize=9999"

// Decision: a run accepts 20 to 200 board codes. IDX listed 59 on
// 2026-11-18 of 944 listed, so fewer means a broken answer, and more would
// put over a fifth of the market on the board. Either way yesterday's table stays.
const MIN_BOARD_CODES = 20
export const MAX_BOARD_CODES = 200

// 109 rows took 44 kB on 2026-11-18, so 1 MB holds every listed code twice.
const MAX_NOTATION_BYTES = 1_000_000

// The notation that marks the board, "listed on the Watchlist Board".
const BOARD_NOTATION = "X"

const Notations = Schema.Struct({
  Results: Schema.Array(
    Schema.Struct({ EmitenCode: Schema.String, Notation: Schema.String })
  ),
})

type SpecialBoardRun =
  | { readonly _tag: "Replaced"; readonly codes: number }
  // The sanity gate dropped the run; yesterday's table stays.
  | { readonly _tag: "Kept"; readonly reason: string }

const isStockCode = Schema.is(StockCode)

const fetchNotations = Effect.gen(function* () {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  return yield* client.get(SPECIAL_NOTATION_URL).pipe(
    Effect.flatMap((response) =>
      readCappedJson(response, MAX_NOTATION_BYTES, "IDX's special notations")
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(Notations)),
    Effect.catchTags({
      HttpClientError: ({ reason }) =>
        Effect.fail(
          new NonRetryable({
            message:
              reason._tag === "StatusCodeError"
                ? `IDX's special notations answered ${reason.response.status} (${SPECIAL_NOTATION_URL})`
                : `IDX's special notations couldn't be read: ${reason.message}`,
          })
        ),
      SchemaError: (error) =>
        Effect.fail(
          new NonRetryable({
            message: `IDX's special notations no longer match their Schema: ${error.message}`,
          })
        ),
    })
  )
})

// The board's codes and their notations, trimmed, or why the run keeps the
// table.
const boardOf = ({ Results }: typeof Notations.Type) =>
  Effect.sync(() => {
    const board = Results.map(({ EmitenCode, Notation }) => ({
      code: EmitenCode.trim(),
      notation: Notation.split(",")
        .map((each) => each.trim())
        .join(","),
    })).filter(({ notation }) => notation.split(",").includes(BOARD_NOTATION))
    const invalid = board.find(({ code }) => !isStockCode(code))
    if (invalid !== undefined)
      return {
        _tag: "Kept",
        reason: `IDX lists a Special Monitoring Board code that isn't a stock code: "${invalid.code}"`,
      } as const
    if (board.length < MIN_BOARD_CODES || board.length > MAX_BOARD_CODES)
      return {
        _tag: "Kept",
        reason: `IDX lists ${board.length} Special Monitoring Board codes, outside the ${MIN_BOARD_CODES}–${MAX_BOARD_CODES} the gate accepts`,
      } as const
    return { _tag: "Board", board } as const
  })

export const syncSpecialBoard = Effect.fn("syncSpecialBoard")(function* (
  fetchedAt: Date
) {
  const read = yield* boardOf(yield* fetchNotations)
  if (read._tag === "Kept") {
    yield* Effect.logWarning("Special Monitoring Board run kept the table", {
      reason: read.reason,
    })
    const kept: SpecialBoardRun = read
    return kept
  }
  // Every row out and the run's in, in one batch, which D1 runs as one
  // transaction: a reader sees yesterday's board or today's, never a mix. At
  // most MAX_BOARD_CODES rows fit one JSON parameter.
  yield* (yield* HoldingsDb).batch([
    { sql: "DELETE FROM special_board", params: [] },
    {
      sql:
        "INSERT INTO special_board (code, notation, fetched_at) " +
        "SELECT value->>0, value->>1, ? FROM json_each(?)",
      params: [
        fetchedAt.toISOString(),
        JSON.stringify(
          read.board.map(({ code, notation }) => [code, notation])
        ),
      ],
    },
  ])
  yield* Effect.logInfo("Special Monitoring Board run replaced the table", {
    codes: read.board.length,
  })
  const replaced: SpecialBoardRun = {
    _tag: "Replaced",
    codes: read.board.length,
  }
  return replaced
})
