# Sweep brokers rows are gzipped BLOBs

A sweep brokers row stores its sweeps as a gzipped BLOB of the answer's text, with the zlib the day store gzips book chunks with. The text repeats broker codes and field names across every sweep, so gzip cuts the day's stored bytes, which Durable Object storage bills, at one gunzip per row read.

Sites:
- `apps/dashboard/src/server/market-live/sweep-brokers.ts`

Source: apinrdw/kumora#555
