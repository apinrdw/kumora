# Measured order book update rates and viewer socket bytes

Task [#496](https://github.com/apinrdw/kumora/issues/496), map [#485](https://github.com/apinrdw/kumora/issues/485). Measured 2026-11-18 on production. It replaces the estimates in [order-book-subscription-capacity.md](../order-book-subscription-capacity.md). The scripts are stored as text so lint skips them; drop the `.txt` to run one.

## Sealed day: 2026-11-17's book chunks

[`books.mjs.txt`](books.mjs.txt) read every share code's book chunk (3,152 codes) for each minute of two windows, 09:00–09:05 and 14:00–14:30 WIB. It rebuilt every served book the way a viewer delta sends it, whole. [`stats.py.txt`](stats.py.txt) summarises the result.

|                                                                         | 09:00–09:05                                   | 14:00–14:30                                   |
| ----------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| Codes with a served book each minute                                    | 1,365                                         | 1,367                                         |
| Served books a second, whole market (mean / p95 second / max second)    | 334 / 421 / 1,823                             | 126 / 164 / 557                               |
| Per code, updates a second (median / p90 / p99 / max)                   | 0.077 / 0.60 / 2.54 / 3.32                    | 0.033 / 0.18 / 1.22 / 1.89                    |
| Busiest codes                                                           | BBRI, TRIN, COIN, INET, BRMS, about 3.2–3.3/s | FOLK, DFAM, TLKM, UNIQ, KOTA, about 1.6–1.9/s |
| Share of updates from the 250 busiest codes                             | 71%                                           | 67%                                           |
| One served book's JSON (median / p90)                                   | 1,186 B / 1,658 B                             | 1,126 B / 1,675 B                             |
| Levels on both sides, median                                            | 28                                            | 26                                            |
| Whole books' JSON a second, per viewer (mean / p95 second / max second) | 364 / 464 / 1,318 KB/s                        | 135 / 172 / 396 KB/s                          |

The day had five relay gaps of 2–7 s, none inside these windows. The 250 ms coalescing caps any code at 4 updates a second, and no code reached that cap.

## Live: the viewer socket, 2026-11-18 10:25 WIB (Session 1)

[`viewer.mjs.txt`](viewer.mjs.txt) opens `/market-live/live` as a browser would. It offers `permessage-deflate`, sends a `Select` of BBCA with an empty watchlist, and counts the bytes on the wire against the bytes after inflating, over 120 s.

- **Compression is negotiated:** `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits=15`.
- **On the wire:** 25.4 KB/s. **Inflated:** 147.9 KB/s. That is about 5.8× compression.
- **Rate:** 3.39 messages a second, and 112 order books a second inside them, averaging 1,165 B each.
- **Share:** order books are **86%** of the inflated bytes.

## What it means

- The earlier estimate, 150–270 KB/s in Session 2 and about 0.5 MB/s at the open, was **uncompressed JSON**. It was about right for Session 2 (135 KB/s) and high for the open (364 KB/s on average, with second-long peaks of 1.3 MB/s).
- Compression divides what a viewer actually downloads by about 6. That gives about 25 KB/s mid-session and an estimated 60–80 KB/s at the open. The browser still parses the full inflated JSON.
- Sending a short reading (about 100 B) instead of the whole book for codes the viewer hasn't selected would cut the book share by about 10×. Books are 86% of what a viewer receives.
