# An archive record key ends in a digest of its listing

The spec's record key `<sha256>.<fetched-at>.json` can't tell apart two listings of the same bytes recorded in the same millisecond, such as one run storing a file IDX uploaded twice, so one would overwrite the other. A shareholding record key ends in a digest of its listing, and a KSEI record key, likewise, in a digest of its (filename, ETag) pair, so each gets its own key.

Sites:

- `apps/dashboard/src/server/shareholding/keys.ts`
- `apps/dashboard/src/server/ksei/keys.ts`

Source: apinrdw/kumora#307, apinrdw/kumora#327
