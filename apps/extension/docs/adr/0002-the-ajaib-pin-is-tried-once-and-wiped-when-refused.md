# The Ajaib PIN is tried once and wiped when refused

A wrong PIN tried twice could lock the owner's Ajaib account, so each PIN entry is tried once. Its PIN sign-in moves from `waiting` to `signing-in` before the call, one check at a time, so no retry, restart or second tick sends it again, and any answer but `signed-in` wipes the PIN. The lock screen gets the kept PIN once per lock, only from an entry read whole, as `signed-in` and marked `typing`, last thing before `type-pin`. The `typing` mark is stored first and cleared once unlocked or when nothing was typed, so a try that a restart cut short counts as refused, and a refused PIN is wiped. Only a new entry is tried again.

Sites:
- `apps/extension/src/worker/ajaib-lock.ts`
- `apps/extension/src/worker/ajaib-session.ts`

Source: apinrdw/kumora#244
