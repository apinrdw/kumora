# The ingest socket reopens on a new WIB date

The dashboard picks a target's trading-day object by WIB date at the ingest socket's handshake, so the socket reopens as soon as the date changes. Its day is read before it dials: read after, a date that moved mid-handshake would keep the socket on the old day's object for a whole day.

Sites:
- `apps/extension/src/worker/target.ts`

Source: apinrdw/kumora#157
