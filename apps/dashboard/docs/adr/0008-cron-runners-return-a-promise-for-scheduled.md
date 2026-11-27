# Cron runners return a Promise for scheduled

A cron runner such as `runArchiveCron` returns a Promise, standing in for Cloudflare's `scheduled`, which CODING_STANDARDS exempts and which reaches it only through `runCron` (`src/server/crons.ts`). The runner lives outside `worker.ts` so a test can run it without TanStack Start; returning the Effect instead would leave the runner the test covers in untested `worker.ts`. The sector and Special Monitoring Board crons follow it.

Sites:

- `apps/dashboard/src/server/shareholding/cron.ts`
- `apps/dashboard/src/server/sectors/cron.ts`
- `apps/dashboard/src/server/special-board/cron.ts`
- `apps/dashboard/src/server/disclosures/cron.ts`

Source: apinrdw/kumora#308
