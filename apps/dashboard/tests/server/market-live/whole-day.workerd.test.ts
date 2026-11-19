// A whole busy day's budgets (spec apinrdw/kumora#555, "Testing Decisions"):
// the busy day recorded live by a fresh object in workerd, its books for the
// codes one viewer watched, sealed and walked (billing/whole-day.ts). It
// runs apart from the row budgets: `pnpm --filter dashboard test:whole-day`.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { BUSY_DAY, WHOLE_DAY } from "../../../billing/busy-figures"

import { BusyDay } from "./workerd"

// Decision: Cloudflare's GB is 10⁹ bytes, as its storage is billed.
const GB = 1e9

// The day records in about 280 s on the machine it was measured on; the
// test gets 15 minutes.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "a whole busy day",
  (it) => {
    it.effect(
      "writes at most 2 M rows and holds at most 0.4 GB, with books for the 30 viewed codes",
      () =>
        Effect.gen(function* () {
          const day = yield* (yield* BusyDay).wholeDay
          // What the PR reports: `pnpm --filter dashboard test:whole-day
          // --silent=false` prints it.
          console.log(JSON.stringify(day, null, 2))
          assert.strictEqual(day.written.trades, BUSY_DAY.trades)
          assert.strictEqual(day.bookCodes, WHOLE_DAY.viewed)
          assert.isAtMost(day.total.rowsWritten, 2_000_000)
          assert.isAtMost(day.databaseBytes, 0.4 * GB)
        }),
      900_000
    )
  }
)
