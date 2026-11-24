// Which archive a row of the report index (report-index.ts) is of: each has
// its own bucket and run machinery. Free of server imports, so the e2e seed
// (apps/e2e/support/report-index.ts) can use it.
export type IndexedArchiveName = "ksei" | "shareholding"
