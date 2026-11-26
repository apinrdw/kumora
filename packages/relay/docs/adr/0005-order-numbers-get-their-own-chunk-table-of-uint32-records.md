# Order numbers get their own chunk table of uint32 records

Broker codes batches may carry each trade's buy and sell order numbers. The trading-day object keeps them in their own chunk table, chunked like the codes, of 9-byte records: buy and sell order number as big-endian uint32, then a source byte; all zero is an absent trade. The first batch carrying order numbers makes the table, so a day recorded before them never has it and reads as before. An order number is at most 2^32 - 1 so it fits a uint32; a day's count reached about 3.1 M by HOPE's last trade on 2026-11-20, three orders of magnitude below it. The source byte is Source's `A`, `S` or `B`, or `D` for Ajaib's that Stockbit's differed from: Ajaib's stand, and a Stockbit row only fills a trade without order numbers. The status's counts move with each record's source byte, so a resent batch counts none twice.

Sites:

- `apps/dashboard/src/server/market-live/broker-codes.ts`
- `packages/relay/src/broker-codes.ts`

Source: apinrdw/kumora#624, apinrdw/kumora#627
