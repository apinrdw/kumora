// Decision: a restart reads only last-frame tables; at most 32 MiB on the heap
// (apps/dashboard/docs/adr/0109-a-restarted-day-keeps-a-bounded-share-of-the-day-in-memory.md)
export const FULL_DAY_CODES = 900
export const FULL_DAY_MINUTES = 438
