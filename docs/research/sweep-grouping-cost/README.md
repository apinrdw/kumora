# Sweep grouping cost at the open (throwaway)

Measurement for apinrdw/kumora#506 ("How long does grouping every code's sweeps take per update at the open?"). Never merged.

The scripts fetch 2026-11-16 09:00–09:03 WIB from production (`SESSION_TOKEN_FILE` points at a file holding the `__Secure-better-auth.session_token` value; see `docs/agents/production-reads.md`), fill the trades the tape GET can't reach from per-code candles, and replay them through the real candle book. They time `book.takeChanged(selected)` per 250 ms delta, with today's selection and with every code selected.

The scripts are stored as text so lint skips them; drop the `.txt` to run one. Order: `fetch-tape.mjs.txt`, `fetch-candles.mjs.txt`, `merge.mjs.txt`, `fill.mjs.txt`. Then run `bench-506.test.ts.txt` from `apps/dashboard/tests/server/market-live/` with `BENCH_DIR` set to the data folder, and summarise with `analyze.mjs.txt`. The cached production data is not committed.

Result for the peak minute (09:00, ~39.6 K trades, 782 codes, Node 26 on an i5-13400, 6 runs): every-code p50 2.2–2.6 ms, p95 4.5–5.4 ms, max 8.1–12.7 ms per delta. Selected-only (3 codes): p50 0.39–0.43 ms.
