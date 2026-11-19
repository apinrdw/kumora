// The Special Monitoring Board list (spec apinrdw/kumora#517, "Ticks, limits
// and excluded codes"): every code on IDX's board. The browser keeps it an
// hour, as the Worker's Cache-Control says (apps/dashboard
// src/server/special-board/list.ts).
import { SpecialBoardPath, decodeSpecialBoard } from "@workspace/relay"
import { Effect, Option } from "effect"

import { getRecorded } from "./recorded-day.ts"

// Empty when the Worker has none to answer.
export const fetchSpecialBoard = Effect.gen(function* () {
  const body = yield* getRecorded(SpecialBoardPath)
  if (Option.isNone(body)) return { fetchedAt: null, codes: [] }
  return yield* decodeSpecialBoard(body.value)
})
