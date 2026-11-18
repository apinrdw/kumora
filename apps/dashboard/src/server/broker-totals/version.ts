// The broker totals build's version. Free of server imports, so the e2e seed
// writes the same one a build would.

// Decision: each built day records the version that built it; a change to
// what the build makes bumps it, and the reconcile rebuilds older days at
// its pace. See apinrdw/kumora#420.
export const BROKER_TOTALS_VERSION = 2
