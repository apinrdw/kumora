# How many frames a second each broker socket sends the relay, by channel

Research for [#230](https://github.com/apinrdw/kumora/issues/230), map [#228](https://github.com/apinrdw/kumora/issues/228). Written 2026-11-12.

## Short answer

Per Stockbit socket, with `order_book`, `liveprice` and `iepiev` listing 690 codes plus `running_trade_batch ["*"]`:

| When                                              | `order_book`           | `liveprice`           | `running_trade_batch`     | `iepiev`                            | Total                                           |
| ------------------------------------------------- | ---------------------- | --------------------- | ------------------------- | ----------------------------------- | ----------------------------------------------- |
| Session 2, typical minute (11-06, 15:00–15:30)    | 99–119 f/s, 53–63 KB/s | 27–32 f/s, 6–7.5 KB/s | 9.2–9.7 f/s, 4.6–7.7 KB/s | 0                                   | **135–160 f/s, 64–77 KB/s**                     |
| Session 2, busiest measured minute (11-06, 14:44) | 160 f/s, 85 KB/s       | 41.5 f/s, 9.6 KB/s    | 10 f/s, 10.7 KB/s         | 0                                   | **212 f/s, 106 KB/s**                           |
| 09:00 open (11-09, 08:59:50–09:01:00)             | ~360 f/s (est.)        | ~85 f/s (est.)        | ~10 f/s                   | 0                                   | **~400–500 f/s** measured; ~200–250 KB/s (est.) |
| Pre-opening (11-09, 08:45–08:58)                  | little                 | little                | 0                         | 4–8 f/s, 48 f/s in the first minute |                                                 |

Per Ajaib socket:

| When                                         | `TRADE *` (one trade per frame)                         | On-demand `ORDER_BOOK_CUSTOM`, 3 codes | On-demand `PRICE`, 3 codes |
| -------------------------------------------- | ------------------------------------------------------- | -------------------------------------- | -------------------------- |
| Session 2 (11-09, 14:08–14:37)               | 35–75 f/s, ~10–22 KB/s (est.)                           | 5.3–8.4 f/s                            | 0.7–1.4 f/s                |
| Session 1 (11-06, 09:36–09:41)               | mean 63, p95 125, p99 190, max 395 f/s                  | –                                      | –                          |
| 09:00 open (11-09, 09:00:01–09:00:16)        | 160–690 f/s per second, ~255 f/s over 09:00:15–09:01:15 | –                                      | –                          |
| Pre-opening match (11-09, 08:58:02–08:58:08) | 950–4,470 f/s                                           | –                                      | –                          |

The every-code subscriptions carry about **93% of a Stockbit socket's frames and 91% of its bytes** in Session 2, and about **98% of its frames at the open**. Subscribing only the watched and selected codes (about 30) would cut a Stockbit socket to an estimated **30–60 f/s and 15–30 KB/s** in Session 2, and about **100–190 f/s** at the open: 60–80% fewer frames. The cut is smaller than the code count suggests, because watched codes are the liquid ones, and they send the most frames.

The extension holds **two** Stockbit sockets (connections A and B) with the same subscription, and two of each Ajaib socket (`apps/extension/src/worker/subscriptions.ts`, `broker.ts`: `connections = ["A", "B"]`). So the extension's input is about twice the per-socket figures: about 300 Stockbit frames/s plus about 100 Ajaib trade frames/s in a typical Session 2 minute, and roughly 1,400–2,200 frames/s in the first seconds after 09:00.

## Sources

There is no production data here, and no 2026-11-12 data at all.

- **Production's trading-day object.** Its book and trade chunks (`apps/dashboard/src/server/market-live/book-chunks.ts`, `day-store.ts`) live in Durable Object SQLite. They are reachable only through the deployed recorded-day GETs, which need a signed-in session. Credentials for that were not available, and none were tried. Even with access, the chunks would not answer this question. They hold every frame the object _served_, after the merge and the `late-frames.ts` drops, and they stamp `servedAt`, not the broker's send time. On a lagged day, that is the extension's output rate, not the broker's input rate.
- **Local dev state.** `apps/dashboard/.wrangler/state/v3` in the main checkout dates from 2026-11-05. Its `do/` directory is empty. There is no `.alchemy` state with a trading day in it.
- **Recorded-day fixtures** (`packages/relay/src/recorded-day.ts`, the dashboard and e2e tests) are synthetic. They carry no broker timing.
- **What was used:** the owner's throwaway probe captures in `~/Downloads/kumora-probe-{stockbit,ajaib}-2026-11-0*.json`. They are not committed, because they include account-scoped request paths. No token or key from them appears here. The [#48](https://github.com/apinrdw/kumora/issues/48) comments summarize the 11-06 captures, and the per-minute rows below are read from the files themselves. A second source is `~/kumora-soak-2026-11-02.log`, a full-day status log of trade counts from an earlier relay.

The probe ran its own test socket beside the page's socket, with the same channel message the relay sends (`subscribeFrame` in `apps/extension/src/worker/stockbit.ts`). The probe's `framesPerSec` and `kbPerSec` are per channel, over 30 s or 60 s windows.

## Stockbit, Session 2: the 51-minute soak (2026-11-06, Friday, 14:40–15:31 WIB)

Source: `kumora-probe-stockbit-2026-11-06T08-48-45-670Z.json`, `testResult.phases`. Channel sizes `{2: 690, 5: 1, 6: 690, 7: 690}`, which is `order_book`, `running_trade_batch`, `liveprice` and `iepiev`. Friday's Session 2 opens at 14:00.

| Minute      | `order_book` f/s (KB/s) | `liveprice` f/s (KB/s) | `running_trade_batch` f/s (KB/s) | Total KB/s | Codes with a book frame |
| ----------- | ----------------------- | ---------------------- | -------------------------------- | ---------- | ----------------------- |
| 14:40       | 116.7 (61.1)            | 34.8 (8.0)             | 9.7 (7.2)                        | 76.3       | 476                     |
| 14:41       | 148.3 (77.2)            | 38.5 (8.9)             | 9.8 (11.8)                       | 97.9       | 480                     |
| 14:42       | 140.0 (75.7)            | 36.6 (8.5)             | 9.7 (7.9)                        | 92.1       | 472                     |
| 14:43       | 146.7 (77.4)            | 38.3 (8.9)             | 9.8 (8.7)                        | 95.0       | 461                     |
| **14:44**   | **160.1 (85.3)**        | **41.5 (9.6)**         | **10.0 (10.7)**                  | **105.6**  | 474                     |
| 14:45       | 158.8 (85.0)            | 42.7 (9.9)             | 9.9 (8.6)                        | 103.5      | 463                     |
| 14:46       | 158.7 (85.2)            | 43.5 (10.1)            | 10.4 (7.6)                       | 102.9      | 478                     |
| 14:47–14:56 | see note                |                        |                                  |            |                         |
| 15:00       | 116.1 (59.4)            | 32.2 (7.5)             | 9.5 (6.5)                        | 73.4       | 449                     |
| 15:05       | 104.8 (57.0)            | 28.7 (6.7)             | 9.6 (5.2)                        | 68.9       | 450                     |
| 15:10       | 106.5 (55.2)            | 29.4 (6.9)             | 9.6 (5.7)                        | 67.8       | 469                     |
| 15:14       | 118.7 (63.3)            | 32.0 (7.5)             | 9.7 (6.6)                        | 77.4       | 461                     |
| 15:20       | 108.7 (59.7)            | 30.7 (7.2)             | 9.7 (6.5)                        | 73.4       | 472                     |
| 15:25       | 99.3 (54.6)             | 28.4 (6.6)             | 9.2 (6.0)                        | 67.2       | 463                     |

The minutes not shown from 15:00 to 15:25 stay within the table's ranges: 99–119 `order_book` f/s and 64–77 KB/s in all. `iepiev` sent nothing during continuous trading. The socket dropped with code 1006 at 15:31:25.

**Background throttling.** Five windows, labelled 14:47, 14:49, 14:51, 14:53 and 14:55, ran 120 s while the probe divided by 60, because the hidden tab's timers were throttled. Their raw rows show about 2×, for example 268.8 `order_book` f/s. Halved, they read 113–134 `order_book` f/s, in line with the rows around them. Without that correction they look like a burst, and they are not one. The busiest honest minute is 14:44.

**Bytes per frame:** `order_book` about 0.53 KB, which is one full side of 45–85 levels as a pipe-joined string. `liveprice` about 0.23 KB. `running_trade_batch` 0.5–1.1 KB, depending on how many trades the batch carries.

**`running_trade_batch` runs near 10 frames/s whatever the trade rate.** That held at 37 trades/s (10:36, 8.8 frames/s), at 63 trades/s (09:37, 9.8 frames/s, peak 379 trades in one second), and at the open. Stockbit batches the tape on a timer of about 100 ms, so busy seconds make the frames bigger, not more numerous. A 3-minute rate check on 11-06 (14:32–14:35, 690 codes, six 30 s windows) agrees: 93.5–105.6 `order_book`, 26–32 `liveprice` and 9.4–9.7 `running_trade_batch` f/s, 56–64 KB/s ([#48](https://github.com/apinrdw/kumora/issues/48)).

**Busiest Session 2 minutes not covered.** The soak ended at 15:31, before the last ten minutes of Session 2. On 2026-11-02 (Monday, from the status log), the busiest Session 2 stretches were 15:40–15:50 (110–141 trades/s over 30 s) and 13:46–13:50 (110–120 trades/s). Session 2 averaged 51 trades/s, and Session 1 averaged 72 trades/s, with a 202 trades/s peak at 11:16. If book frames rise with trade rate as they did between 14:44 and 15:25, the 15:40–15:50 stretch would send about 200–250 `order_book` f/s per socket. That is an **estimate**, not a measurement.

## Stockbit, the 09:00 open (2026-11-09, Monday)

Source: `kumora-probe-stockbit-2026-11-09T02-01-21-573Z.json`. Three test sockets ran side by side: (a) `running_trade_batch ["*"]` alone, (b) `liveprice` and `iepiev` for BBCA, BBRI and GOTO, and (c) the relay's full load for 690 codes. Each window counts the frames on each socket for about the previous minute.

- **Pre-opening (08:45–08:58).** Socket c's frames were almost all `iepiev`. The first minute sent 2,882 (48 f/s), and later minutes sent 210–480 (4–8 f/s). At 08:58, the pre-opening match, 2,660 non-`iepiev` frames arrived in a minute. `iepiev` stopped by 08:58:50 and sent 7,099 frames from 564 codes in all.
- **The open.** Socket c dropped with code 1006 at **09:00:02**. Its last 12 s (08:59:50–09:00:02) carried about 4,856 frames, about **400 f/s**. That count is derived: the attempt's 15,184 frames minus the earlier windows' sum. It reopened at 09:00:32 and took **13,292 frames in 28 s, about 475 f/s**. The window 09:00:50–09:01:00 shows 4,994 frames in 10 s, about **500 f/s**. That is 3–3.5× the Session 2 rate.
- **Split by channel at the open: estimated.** The windows count all channels together. Over the whole capture, socket c took 17,011 `order_book`, 3,944 `liveprice` and 310 `running_trade_batch` frames, and at least 85% of those three arrived after 08:59:50. Applying that 80 : 18.5 : 1.5 ratio to about 450 f/s gives about 360 `order_book`, 85 `liveprice` and 10 `running_trade_batch` f/s. Socket a confirms `running_trade_batch` stayed near 10 f/s: 498 frames in the minute to 09:00:50, then 101 in 10 s. Each batch was large: Stockbit's tape carried 1,990 trades in the second 09:00:01 and 1,624 in 09:00:02.
- **Bytes at the open: estimated** at Session 2's bytes per frame: about 200–250 KB/s per socket.

**Closing auction (2026-11-09, 15:50–16:00).** Source: `kumora-probe-stockbit-2026-11-09T09-04-29-233Z.json`. Socket c's first window to 15:50:48 had 4,660 frames (78 f/s), and later windows had 560–1,460 frames a minute, most of them `iepiev`: 8,927 frames from 599 codes over the run. That is light next to the open.

## Ajaib

The relay's Ajaib sockets are `TRADE` with `"*"` (the whole tape, one trade per frame), plus on-demand `PRICE`, `INDICATIVE` and `ORDER_BOOK_CUSTOM` sockets that subscribe only the codes viewers watch or select (`makeAjaibSubscriptions`; `apps/dashboard/src/server/market-live/on-demand.ts`). Each socket is held twice, as connections A and B.

- **Session 2, 30 minutes** (11-09, 14:08–14:37; `kumora-probe-ajaib-2026-11-09T08-05-44-523Z.json`, BBCA, BBRI and GOTO on demand): `TRADE` sent 2,125–4,499 frames a minute, **35–75 f/s**, about 46 f/s on average. `ORDER_BOOK_CUSTOM` for the three codes sent 319–506 a minute (**5.3–8.4 f/s**, about 2–2.8 per code). `PRICE` for the three codes sent 39–86 a minute (0.7–1.4 f/s). Connections A and B matched frame for frame.
- **Session 1, per second** (11-06, 09:36–09:41; `kumora-probe-ajaib-2026-11-06T02-41-21-785Z.json`, 19,571 trades): mean **63 f/s**, p50 56, p95 125, p99 190, max **395 f/s**.
- **The open** (11-09; `kumora-probe-ajaib-2026-11-09T02-01-26-869Z.json`): the seconds 09:00:01–09:00:16 delivered 162–688 trades, so **160–690 f/s**. The window 09:00:15–09:01:15 delivered 15,295 frames, about **255 f/s**. The pre-opening match delivered **950–4,470 f/s** over 08:58:02–08:58:08, the highest rate in any capture.
- **Bytes: estimated.** One trade re-serialized as compact JSON is about 290 bytes, so `TRADE` runs about 10–22 KB/s in Session 2, about 50–200 KB/s at the open, and up to about 1.3 MB/s in the pre-opening match. The raw frame may differ from the probe's re-serialization. For comparison, Ajaib's `PRICE *` (which the relay does not use) measured 102 f/s and 21 KB/s, about 0.2 KB per frame ([#48](https://github.com/apinrdw/kumora/issues/48)).

## Share carried by the every-code subscriptions

Today `liveprice`, `order_book` and `iepiev` list every code on Stockbit (`subscribeFrame`). `running_trade_batch` uses the `"*"` wildcard, and the tape needs it whatever the code list.

| Stockbit socket                          | Every-code channels | `running_trade_batch` | Every-code share                |
| ---------------------------------------- | ------------------- | --------------------- | ------------------------------- |
| Session 2, typical (15:00–15:30 average) | ~138 f/s, ~65 KB/s  | 9.6 f/s, ~6 KB/s      | **93% of frames, 91% of bytes** |
| Session 2, busiest minute (14:44)        | 202 f/s, 95 KB/s    | 10 f/s, 10.7 KB/s     | 95% of frames, 90% of bytes     |
| Open (estimate)                          | ~445 f/s            | ~10 f/s               | **~98% of frames**              |

**Production lists more than 690 codes.** The relay subscribes Ajaib's whole code list, which held 3,406 codes on 11-06, warrants included (`apps/extension/src/worker/code-list.ts`, `listedCodes` in `ajaib.ts`, wired in `service-worker.ts`). Every test above listed only 690 four-letter codes. Load follows active codes, not listed ones: listing 250 codes gave 110 f/s, and listing 690 gave about 140. So the extra listed codes add only what they trade. The 11-02 log saw 865 distinct codes trade over the day, against 690 in the test list, so production's every-code load is probably 10–25% above the figures here. That is an **estimate**.

## What subscribing only watched and selected codes would cut it to

Estimated. The probes did not record frame counts per code, so this rests on three anchors:

1. The 250 most active codes (collected from the tape) sent 77.5 of about 100 `order_book` f/s, and 21 of about 29 `liveprice` f/s.
2. The busiest single codes send about 2–3 book frames a second: BBCA 2.6 f/s on Stockbit, and BBCA, BBRI and GOTO 2–2.8 f/s each on Ajaib.
3. About 460 codes send a book frame in a typical Session 2 minute, an average of 0.24 f/s per code.

For about 30 watched and selected codes, mostly liquid ones (the owner's Stockbit watchlist had 28): `order_book` about 15–40 f/s, `liveprice` about 3–9 f/s, `running_trade_batch` unchanged at about 10 f/s, and `iepiev` about 1 f/s in pre-opening.

| Stockbit socket    | Today (690 codes)       | Watched and selected only (estimate) |
| ------------------ | ----------------------- | ------------------------------------ |
| Session 2, typical | 135–160 f/s, 64–77 KB/s | **30–60 f/s, 15–30 KB/s**            |
| Open               | ~400–500 f/s            | **~100–190 f/s**                     |

That removes 60–80% of Stockbit's frames. Two other levers stack with it. The second Stockbit connection doubles every frame, and the whole-market `TRADE` tape on Ajaib cannot be narrowed. Narrowing also means the trading-day object no longer gets books and prices for codes nobody watches. Recorded days would then hold no order book chunk for those codes, which is a product choice for the map.

The figure that would settle this is a per-code frame count over one Session 2 minute and one minute at the open. The next probe run should record it: a `Map<code, count>` per channel.

## Confidence

| Figure                                               | Basis                                                       | Confidence                                         |
| ---------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Stockbit Session 2 rates by channel, 14:40–15:31     | 51 measured 1-minute windows, one day (11-06)               | High for that window. Throttled windows corrected. |
| `running_trade_batch` about 10 f/s whatever the load | Five captures across 11-06 and 11-09                        | High                                               |
| Stockbit open total, 400–500 f/s                     | Window counts on 11-09, one socket that dropped at 09:00:02 | Medium                                             |
| Stockbit open split by channel, and its bytes        | Whole-run ratio and Session 2 bytes per frame               | Low (estimate)                                     |
| Stockbit 15:40–15:50 rush, 200–250 `order_book` f/s  | Scaled from 11-02 trade rates                               | Low (estimate)                                     |
| Ajaib `TRADE` frame rates                            | Per-trade arrival times (11-06) and window counts (11-09)   | High. Frames equal trades.                         |
| Ajaib bytes                                          | Re-serialized record size                                   | Low (estimate)                                     |
| Production's 3,406-code list adding 10–25%           | 865 traded codes on 11-02                                   | Low (estimate)                                     |
| Watched-only cut to 30–60 f/s                        | Three anchors, no per-code counts                           | Low (estimate)                                     |
| Anything on 2026-11-12 itself                        | No data                                                     | None                                               |
