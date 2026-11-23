# No chunk buffer outlives its chunk's step

A sparse tape's 10,000 trades can span 10,000 chunks of 32 KB each, and none of those may sit in memory together. So no chunk buffer outlives its chunk's step: a scan decodes or reduces each stored trade to plain values before it reads the next chunk, and a write stores each chunk before it reads the next.

Sites:
- `apps/dashboard/src/server/market-live/tape-chunks.ts`

Source: apinrdw/kumora#574
