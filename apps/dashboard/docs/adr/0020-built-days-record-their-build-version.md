# Built days record their build version

Each built day records the build version that built it. A change to what the build makes bumps the version, and the reconcile rebuilds older days at its own pace: at most 20 accepted pokes a run, newest first, so a bump or a backlog re-derives history at about 20 days a day and never bursts D1's writes. A day that answers it won't build (204) or whose poke fails takes no slot, so days that never become buildable cannot starve older ones.

Sites:

- `apps/dashboard/src/server/broker-totals/version.ts`
- `apps/dashboard/src/server/broker-totals/reconcile.ts`

Source: apinrdw/kumora#420
