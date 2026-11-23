// The broker totals build's version. Free of server imports, so the e2e seed
// writes the same one a build would.

// Decision: each built day records its build version; a bump rebuilds older days
// (apps/dashboard/docs/adr/0020-built-days-record-their-build-version.md)
export const BROKER_TOTALS_VERSION = 2
