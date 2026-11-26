# A day's tape source is set once

A day's tape source is unknown until its first relay trade before 17:00 makes it relay, or a walk's first fields make it walk, and it is kept for good. A relay day seals at 17:00, a walk day once buildable from 17:00, and an unknown day never. Walk rows hold on a relay day and on any sealed day, so a later, higher `end` leaves no sealed day short.

Sites:

- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#449
