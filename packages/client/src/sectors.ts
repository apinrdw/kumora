// The sector map (spec apinrdw/kumora#427, "Sectors"): every classified stock
// code's IDX-IC sector. The browser keeps it an hour, as the Worker's
// Cache-Control says (apps/dashboard src/server/sectors/map.ts).
import { SectorsPath, decodeSectorMap } from "@workspace/relay"
import { Effect, Option } from "effect"

import { getRecorded } from "./recorded-day.ts"

// Empty when the Worker has none to answer.
export const fetchSectors = Effect.gen(function* () {
  const body = yield* getRecorded(SectorsPath)
  if (Option.isNone(body)) return { fetchedAt: null, sectors: {} }
  return yield* decodeSectorMap(body.value)
})
