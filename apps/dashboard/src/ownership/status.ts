import { calendarOutOfDate } from "@/relay/calendar"

import type { AsOf } from "./as-of"
import { DATASETS } from "./csv"
import type { Dataset } from "./csv"
import { expectedAsOf, freshness } from "./late"
import type { ExpectedAsOf, OwnershipFreshness } from "./late"
import type { LatestFile, readStatusRows } from "./store"

/* The status response. Pure: the stored rows and the time in, the contract's shape out. */

type FeedStatus = {
  readonly freshness: OwnershipFreshness
  readonly asOf: AsOf | null
  readonly expectedAsOf: ExpectedAsOf
  readonly firstReceivedAt: string | null
}

const feedStatus = (
  dataset: Dataset,
  latest: LatestFile | undefined,
  now: number
): FeedStatus => {
  const asOf = latest?.as_of ?? null
  const expected = expectedAsOf(dataset, now)
  return {
    freshness: freshness(asOf, expected),
    asOf,
    expectedAsOf: expected,
    firstReceivedAt: latest?.first_received_at ?? null,
  }
}

/** Lateness is judged at `now`. */
export const statusResponse = (
  rows: Awaited<ReturnType<typeof readStatusRows>>,
  now: number
) => ({
  feeds: Object.fromEntries(
    DATASETS.map((d, i) => [d, feedStatus(d, rows.latest[i], now)])
  ),
  calendarListed: !calendarOutOfDate(now),
  lastRun: rows.lastRun,
  // The operator's `_scripts/kirim.py`, outside this repo, waits on these keys. Change the two together.
  loading: rows.files
    .filter((file) => file.status === "loading")
    .map((file) => ({
      fileId: file.id,
      dataset: file.dataset,
      asOf: file.as_of,
    })),
  failed: rows.files
    .filter((file) => file.status === "failed")
    .map((file) => ({
      fileId: file.id,
      dataset: file.dataset,
      asOf: file.as_of,
      error: file.error,
    })),
  flaggedRows: rows.flaggedRows,
})
