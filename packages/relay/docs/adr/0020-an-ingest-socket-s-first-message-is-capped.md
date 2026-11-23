# An ingest socket's first message is capped

The trading-day object closes a new ingest socket's first message with 4403 unread when it passes a fixed number of UTF-16 units, so a client without the token can't make it decode a 32 MiB Frames envelope. A token message is 91 units (47 plus a 44-character token). Later envelopes have no bound here.

Sites:
- `packages/relay/src/envelope.ts`

Source: apinrdw/kumora#157
