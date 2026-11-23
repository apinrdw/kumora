# Cold days sit under days/{date}/ with versioned answers

A cold day's R2 keys sit under `days/{date}/`. Its answers sit in a folder named for their stored format's version (`ANSWERS_VERSION`), as each was built for a page, with `status.json` (the broker codes protocol's) and `manifest.json` beside that folder. The folder names the stored answers' format, not the live socket's protocol: protocol 8 changed only live book readings and protocol 9 left stored answers alone, so days already moved stay under `v7`, new days still go there, and order flow events sit there too rather than in the spec's `v9`.

The version is bumped only when a stored answer's format changes. Such a change either converts on read or rewrites the days already moved, R2 to R2.

Sites:
- `apps/dashboard/src/server/market-live/cold-bucket.ts`

Source: apinrdw/kumora#556, apinrdw/kumora#606, apinrdw/kumora#612
