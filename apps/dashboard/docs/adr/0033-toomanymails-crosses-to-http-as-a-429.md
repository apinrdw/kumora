# TooManyMails crosses to HTTP as a 429

CODING_STANDARDS' closed `HttpError` set binds server functions through `runServerEffect`, but an auth callback answers through Better Auth. `TooManyMails` crosses to HTTP as a 429 with a retry header, beside that closed set, because the spec prescribes that answer for the per-address mail cap. This is the one place a sixth error crosses to HTTP.

Sites:

- `apps/dashboard/src/server/auth/callbacks.ts`

Source: apinrdw/kumora#80
