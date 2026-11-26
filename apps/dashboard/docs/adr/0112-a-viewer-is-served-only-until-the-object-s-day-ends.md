# A viewer is served only until the object's day ends

A ban, revoke or delete reaches today's trading-day object alone, so a socket still served on yesterday's object would outlive it. A viewer is therefore served only until the object's day ends: past it, the socket is closed with 1001 when it would next be served, and the page reconnects through the gate to today's object.

Sites:

- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#157
