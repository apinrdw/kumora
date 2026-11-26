# A holdings parse fits a bounded heap

Parsing a holdings report, KSEI's or one of IDX's, takes at most 48 MiB of heap (`PARSE_HEAP_MIB`), so the Worker's 128 MiB still holds the archived file and the run around it. Each input cap keeps a parse under that bound, set at a multiple of the largest real data: an entry inflates to at most 8 MiB, counted as it inflates; a zip's central directory takes at most 64 KiB; shared strings inflate to at most 1 MiB; the above-1% report holds at most 15,000 rows, with an `INVESTOR_NAME` of at most 256 characters and other text of 128; the daily above-5% report holds at most 8,000 rows (2.5× the 3,188 of its largest day), each storing a holder's and an account's names of at most 256 characters and other text of 128, and leaves at most 8 share counts of a block's side ambiguous; a month lists at most 2,000 stocks in any report; and a classification header label or issuer name is at most 256 characters. `tests/server/holdings/bounded-heap.ts` checks the bound: 20,000 rows of 256-character texts, or two 8 MiB parts, took a parse past it, and so did 12,000 above-5% rows.

Sites:

- `apps/dashboard/tests/server/holdings/bounded-heap.ts`
- `apps/dashboard/src/server/holdings/above-1.ts`
- `apps/dashboard/src/server/holdings/above-5.ts`
- `apps/dashboard/src/server/holdings/month-replace.ts`
- `apps/dashboard/src/server/holdings/xlsx.ts`
- `apps/dashboard/src/server/holdings/zip.ts`
- `apps/dashboard/src/server/holdings/classification.ts`

Source: none
