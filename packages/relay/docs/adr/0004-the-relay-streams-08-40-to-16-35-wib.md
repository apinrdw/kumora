# The relay streams 08:40 to 16:35 WIB

The relay holds its broker sockets open from 08:40 to 16:35 WIB on a trading day, breaks included: five minutes before pre-opening to five minutes after the negotiated market ends. A narrower window loses auction data; a wider one costs little. A connection opened mid-auction is unproven, so during pre-opening and pre-closing a dropped connection reconnects but none opens fresh. A year missing from the schedule streams nothing, so a stale holiday table fails quiet rather than relaying a holiday.

Sites:
- `packages/relay/src/schedule.ts`
- `apps/extension/src/worker/gate.ts`

Source: apinrdw/kumora#62
