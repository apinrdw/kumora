// The KSEI report kinds and how the admin page names them. Free of server
// imports, so the page's components and the e2e seed can use it.
import { Schema } from "effect"

export const KseiReportKind = Schema.Literals([
  "securities-statistics",
  "securities-holdings",
])
export type KseiReportKind = typeof KseiReportKind.Type

export const KIND_LABEL: Record<KseiReportKind, string> = {
  "securities-statistics": "Securities statistics",
  "securities-holdings": "Securities holdings",
}
