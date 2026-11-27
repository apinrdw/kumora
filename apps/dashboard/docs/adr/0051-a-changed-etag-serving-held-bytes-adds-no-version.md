# A changed ETag serving held bytes adds no version

A URL's ETag can change while IDX serves the same file. When a changed ETag serves bytes that a record of that URL already holds, the archive run adds a record but no new version, since the file didn't change.

Sites:

- `apps/dashboard/src/server/shareholding/archive-run.ts`

Source: apinrdw/kumora#307
