// The shareholding archive's rows in the report index
// (../archive/report-index.ts): written by its run's `report:` steps, healed
// by its `plan`, read by the admin page for the totals (totals.ts) and the
// parse coverage.
import { reportIndexOf } from "../archive/report-index.ts"
import { reportKey } from "./keys.ts"
import { ReportKind } from "./listing.ts"

export const shareholdingIndex = reportIndexOf({
  name: "shareholding",
  kind: ReportKind,
  fileKey: reportKey,
})
