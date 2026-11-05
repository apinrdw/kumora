// Produces expected.json from capture.json through the exact-percentile reference
// logic, once. `src/relay/whale.ts` is compared against its output, so run this only
// if the capture or the definition changes.
//
//   node apps/dashboard/tests/fixtures/whale/generate.mts
import { writeFileSync } from "node:fs"

import { SYMBOL_PATTERN } from "../../../src/domain/symbol-guard.ts"
import { readCapture, SIDE } from "../../support/whale-capture.ts"
import {
  buildPriors,
  createState,
  defaults,
  feed,
  mergeStream,
} from "./whale-logic.mjs"

const CUT = "2026-10-29T06:30:01.332Z"

const capture = readCapture()
const batches = capture.batches.map((b) => ({
  ...b,
  trades: b.trades.filter((row) => SYMBOL_PATTERN.test(row[0])),
}))
const live = capture.liveprice.filter((row) => SYMBOL_PATTERN.test(row[1]))
const stream = mergeStream(batches, live)
const priors = buildPriors(stream, CUT, defaults)

const state = createState(priors)
for (const ev of stream) if (ev.t >= CUT) feed(state, ev, defaults)

const expected = {
  cut: CUT,
  fed: state.fed,
  priors,
  // `sweep.order.sweep` is a cycle, so each is picked apart rather than stringified.
  sweeps: state.sweeps.map((s) => ({
    symbol: s.symbol,
    firstNumber: s.first,
    side: SIDE[s.side],
    lots: s.order.lots,
    freq: s.order.n,
  })),
  // Maker orders that never crossed are in `state.walls` too.
  walls: state.walls
    .filter((w) => w.announced)
    .map((w) => ({
      symbol: w.symbol,
      side: w.side,
      price: w.price,
      hits: w.hits,
      lots: w.lots,
    })),
}

writeFileSync(
  new URL("expected.json", import.meta.url),
  `${JSON.stringify(expected, null, 1)}\n`
)
console.log(
  `${expected.fed.trades} trades, ${expected.sweeps.length} sweeps, ${expected.walls.length} walls`
)
