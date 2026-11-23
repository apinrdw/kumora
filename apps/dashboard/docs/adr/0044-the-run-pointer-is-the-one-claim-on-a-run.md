# The run pointer is the one claim on a run

The cron and Run now can both start an archive run. The run pointer is the one claim on starting one, written in one conditional R2 write only while its ETag is the one this start judged. Of two starts that read the same pointer, one claims it and the other judges again against the winner.

Sites:
- `apps/dashboard/src/server/archive/runs.ts`

Source: apinrdw/kumora#309
