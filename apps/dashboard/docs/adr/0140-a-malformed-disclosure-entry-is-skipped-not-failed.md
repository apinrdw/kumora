# A malformed disclosure entry is skipped, not failed

A disclosure run fails only when IDX's list of a recent day can't be read (an older day's is left for the next run, ADR 0138): a page that doesn't answer 2xx, isn't JSON, is over its byte cap or no longer matches the listing's shape. One entry that the archive can't take as it stands is skipped instead, and the rest of its day is stored. A reply whose `Id2` isn't a publish time, a number and the language's suffix, or whose key is over its length cap, has no disclosure key (ADR 0136), so the whole reply is skipped. An attachment whose `FullSavePath` isn't a URL, or whose path is over its length cap, is skipped, and its version is still stored with the reply exactly as IDX sent it. A reply's size alone skips nothing: it goes to the bucket, never into a step result, and the page's byte cap bounds it. The run counts what it skipped, keeps why for the first few on its record, and ends partial, so the admin page shows them.

A skipped entry doesn't wait (ADR 0138), so its day can still be complete, and once it is no run lists it again: what was skipped is never stored. Keeping the day incomplete was the alternative, but backfill takes the oldest incomplete day first, so every run would list that day again for an entry IDX keeps listing the same way. Failing the run was the first design, and since backfill takes that day first, every later run failed on it.

Sites:

- `apps/dashboard/src/server/disclosures/listing.ts`
- `apps/dashboard/src/server/disclosures/archive-run.ts`

Source: apinrdw/kumora#715
