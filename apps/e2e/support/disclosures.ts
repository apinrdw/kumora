// Seeds disclosure runs into the Test stage's ArchiveDb, as a start and its
// run's steps would write them.
import type { DisclosureRunResult } from "../../dashboard/src/server/disclosures/run-result.ts"
import { seedRunRow } from "./runs"

/** A disclosure run's result, as its ArchiveDb row holds it. */
export type SeededDisclosureRun = typeof DisclosureRunResult.Encoded

/**
 * Writes the run's row and leaves the last run alone, so it can run beside
 * the specs that make their own run the last.
 */
export async function seedDisclosureRun(run: SeededDisclosureRun) {
  seedRunRow("disclosure", "archive", run, { latest: false })
}

/** Writes the run's row as the last run. */
export async function seedLatestDisclosureRun(run: SeededDisclosureRun) {
  seedRunRow("disclosure", "archive", run, { latest: true })
}
