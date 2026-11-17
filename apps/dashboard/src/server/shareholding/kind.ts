// How the admin page names each shareholding report kind (GLOSSARY.md,
// "Report kind"). Free of server imports, so the page's
// components and its route can use it.
import type { ReportKind } from "./listing.ts"

export const KIND_LABEL: Record<ReportKind, string> = {
  "above-5": "Holders above 5%",
  "above-1": "Holders above 1%",
  "investor-type": "Holdings by investor type",
  "investor-classification": "Holdings by investor classification",
  other: "Other",
}
