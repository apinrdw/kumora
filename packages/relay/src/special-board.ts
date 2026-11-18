// The codes on IDX's Special Monitoring Board (spec apinrdw/kumora#517,
// "Ticks, limits and excluded codes"): the dashboard keeps IDX's list in a
// table each day and serves it at SpecialBoardPath. A board code trades in a
// call auction all day, so the Book readout and the scanner leave it out.
import { Schema } from "effect"

import { StockCode } from "./codes.ts"

export const SpecialBoardPath = "/market-live/special-board"

const SpecialBoard = Schema.Struct({
  // When the table was last replaced, an ISO instant; null before the first
  // run.
  fetchedAt: Schema.NullOr(Schema.String),
  codes: Schema.Array(StockCode),
})

export const decodeSpecialBoard = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SpecialBoard)
)
export type SpecialBoard = typeof SpecialBoard.Type
