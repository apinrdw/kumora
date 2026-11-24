// The KSEI archive's rows in the report index (../archive/report-index.ts):
// written by its run's `report:` steps, healed by its `plan`, read by the
// admin page for the totals, the coverage and the parse coverage.
import { Effect, Schema } from "effect"

import type { PageRead } from "../archive/page-read.ts"
import { reportIndexOf } from "../archive/report-index.ts"
import { decodeRows } from "../d1.ts"
import { reportKey } from "./keys.ts"
import { KseiReportKind } from "./kind.ts"
import { kseiTotals } from "./totals.ts"

export const kseiIndex = reportIndexOf({
  name: "ksei",
  kind: KseiReportKind,
  fileKey: reportKey,
})

const HeldMonthRow = Schema.Struct({
  kind: KseiReportKind,
  month: Schema.String,
})

// Each kind's totals and the months it holds (YYYY-MM).
export const kseiReportIndex = {
  kinds: [],
  statements: [
    ...kseiIndex.kindTotals.statements,
    {
      sql:
        "SELECT DISTINCT kind, substr(report_date, 1, 7) AS month " +
        "FROM archived_report WHERE archive = ?",
      params: [kseiIndex.name],
    },
  ],
  read: ([totalsRows = [], monthRows = []]) =>
    Effect.gen(function* () {
      const months = yield* decodeRows(HeldMonthRow)(monthRows)
      const held = (kind: KseiReportKind) =>
        new Set(
          months.filter((row) => row.kind === kind).map(({ month }) => month)
        )
      return {
        totals: yield* kseiTotals(
          yield* kseiIndex.kindTotals.read([totalsRows])
        ),
        monthsHeld: {
          "securities-statistics": held("securities-statistics"),
          "securities-holdings": held("securities-holdings"),
        },
      }
    }),
} satisfies PageRead<unknown>
