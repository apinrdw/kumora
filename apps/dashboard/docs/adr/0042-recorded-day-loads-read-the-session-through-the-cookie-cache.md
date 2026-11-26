# Recorded day loads read the session through the cookie cache

Play fetches a recorded day's tape up to 4 times a second, so, as the spec says, recorded day loads read the session through Better Auth's 5-minute cookie cache. A ban or revoke therefore bites here only within those 5 minutes, while the live socket reads past the cache and closes at once. A denial fails with the access policy's refusal.

Sites:

- `apps/dashboard/src/server/market-live/days.ts`

Source: none
