# Book event thresholds, tuned on a recorded day

Wayfinder task [#508](https://github.com/apinrdw/kumora/issues/508). It picks the fixed defaults for the book events defined in [#491](https://github.com/apinrdw/kumora/issues/491), using the level ledger from `docs/research/book-absorption-reload-walls.md` on branch `research/book-absorption-reload-walls`.

## The numbers

| Threshold                                        | Default                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Absorption `k`                                   | **1**                                                | The level traded at least all the lots it showed at the window's start. Below 1, the level hasn't turned over once, so "absorbed" loses its meaning. At 1.5 or 2, absorption falls by about 40% on busy codes and to almost nothing on mid and quiet ones: 0–0.06 a minute at the open, and 0 after it.                                                                                                                                                                                                                        |
| Floor for absorbed, eaten and reloaded levels    | **Rp100 million**                                    | Absorbed and reloaded apply it to the traded value. Eaten applies it to the level's peak value in the window. At Rp250 million, mid codes at the open drop from 0.48 to 0.20 events a minute, and mid-code absorption disappears. Rp100 million is 181 lots of BBCA and 14,000 lots of KOTA.                                                                                                                                                                                                                                   |
| Wall multiple `m`                                | **5**                                                | At 3, the median busy code shows a wall on most sides almost all the time (max/median is 3.9–4.1 on TLKM, FOLK and BBNI), so a wall is no longer an outlier. At 5, 24% of busy-code sides and 35% of mid-code sides carry a wall. At 8, almost none do (7% busy).                                                                                                                                                                                                                                                              |
| Wall floor                                       | **Rp500 million**                                    | At Rp1 billion, the most telling sequence on the day disappears: four 50,000-lot bids at FOLK 98–101 (about Rp500 million each), then pulled. Quiet codes' thin books make many small walls. Rp500 million cuts their standing walls from 1.86 to 1.53 a side, compared with Rp250 million.                                                                                                                                                                                                                                    |
| Eaten share                                      | **0.6** of the level's peak lots in the window       | The share is bimodal. Of 231 best-3 or wall levels that left the book, 153 had trades of at least 0.9× the peak and 13 had under 0.25×. Only 12 fall between 0.4 and 0.6, so any value from 0.5 to 0.75 gives about the same events.                                                                                                                                                                                                                                                                                           |
| Pulled: trades explain less than `X` of the loss | **X = 0.25**                                         | Of 14 walls that lost half their lots, 8 had no trades at all, 1 had 0.24× (KOTA 72, a wall partly eaten and then cancelled), and 5 had 0.6× or more. Any `X` from 0.1 to 0.5 gives the same events, except at the one KOTA case.                                                                                                                                                                                                                                                                                              |
| Moved                                            | **±20% lots, within 2 frames, compared as a change** | Keep ±20% and 2 frames. Change what is compared. The #491 rule compares whole levels (similar lots, same order count). It never fired, because a wall is usually several orders and its level's order count changes when one of them moves. Comparing the change does fire: the lots that left `p` are within ±20% of the lots that arrived at `p′`, and the order count fell at `p` by as many as it rose at `p′`. It caught the one real move in the sample (BBNI 3620 → 3610). Loosening to ±50% and 4 frames adds nothing. |
| "As price approached" distance                   | **3 ticks** (confirmed)                              | Every pull in the sample happened 0–1 ticks from the touch, except two deep pulls (7 and 18 ticks). Both "approached" pulls had the touch move to the wall (1 tick, then 0). There are too few pulls to tighten it.                                                                                                                                                                                                                                                                                                            |

Unchanged from #491: the 30 s window, at least 2 frames per side in the window, and only regular-board trades with a buy or sell aggressor.

## Event rates at these numbers

The data is 2026-11-17 (sealed), WIB, Session 1 09:00–09:30 and Session 2 14:00–14:30, 15 codes. A code's class is set by its regular-board trade count from 14:00 to 14:30:

- **Busy (over 800 trades):** TLKM, BBRI, KOTA, BBCA, FOLK.
- **Mid (150–800):** GOTO, BBNI, AKRA, MEDC, DSSA, SMGR.
- **Quiet (under 150):** ERAA, TAPG, PANI, PNBN.

The table gives events per code per minute, averaged over the class. The first 30 s of each window is not evaluated.

| Window                      | Class | Absorbed | Eaten | Reloaded | Appeared | Pulled | Moved | Total    |
| --------------------------- | ----- | -------- | ----- | -------- | -------- | ------ | ----- | -------- |
| Open 09:00–09:15            | busy  | 0.52     | 1.12  | 0.10     | 0.00     | 0.00   | 0.00  | **1.74** |
|                             | mid   | 0.08     | 0.33  | 0.02     | 0.05     | 0.00   | 0.00  | **0.48** |
|                             | quiet | 0.00     | 0.12  | 0.00     | 0.05     | 0.00   | 0.00  | **0.17** |
| 09:15–09:30 and 14:00–14:30 | busy  | 0.13     | 0.26  | 0.03     | 0.03     | 0.02   | 0.00  | **0.47** |
|                             | mid   | 0.02     | 0.11  | 0.00     | 0.01     | 0.01   | 0.00  | **0.15** |
|                             | quiet | 0.01     | 0.02  | 0.00     | 0.00     | 0.01   | 0.00  | **0.03** |

- **Busiest minutes:** TLKM and FOLK reached 7 events in one minute, KOTA 6 and BBRI 5, all near the open. BBCA reached 3. No code produced dozens.
- **Silent codes:** GOTO had no events in 75 minutes. BBCA and BBRI had none after 09:15, because their best price never moved: BBCA's best bid and offer stayed at 5525/5550 for the whole of 14:00–14:30, with 27,000-lot queues and about 800 trades.
- **Too quiet to read:** quiet codes are too quiet on 30–40% of their sides in Session 2, and on 1–27% at the open. Mid codes are too quiet on 0–11%, and busy codes never.
- **Per code:** run `sweep.mjs` with `PER=1` (see Rerun).

**The target can't be reached by thresholds alone.** Even at loose settings (`k` 0.5, a Rp50 million floor, `m` 3, no wall floor), busy codes reach only 2.8 events a minute at the open and 0.7 after it. Book events follow price movement: eaten needs the touch to move, and absorbed needs a queue that trades its own size in 30 s. On a calm afternoon a deep blue chip gives almost none. The defaults therefore sit at the loose end that still reads correctly by eye. There is no headroom to tighten them for a quieter scanner.

## Spot checks

The `spot.mjs` output below shows each event's level frame by frame, plus the trades at its price.

1. **Absorbed, KOTA bid 72, 09:24:31.** The level started the window at 2,574 lots, took 55,242 lots of selling, and grew to 106,000 lots across 139 orders. Price never traded below 72. **Right**: a strong one.
2. **Absorbed, FOLK offer 110, 09:15:59.** The offer showed 18,336 lots and took 19,994 lots of buying. It stood, then the price fell away to 108. **Right**: resistance held.
3. **Absorbed, TLKM bid 2170, 09:02:03 (first draft of the rule).** The level was eaten (the best went to 2160) and re-formed at 2170 with 3 new orders, inside the window. **Wrong.** Fix, now in the script: a level counts as absorbed only if it is present in every frame of the window. With the fix, that moment is reported as eaten at 09:02:03.315.
4. **Eaten, KOTA bid 67, 14:24:00.** 79,264 lots across 222 orders. 67,110 lots of selling hit it, then the best bid went to 66. **Right.**
5. **Eaten, FOLK offer 120, 14:23:01.** The offer built to 48,375 lots, took 55,836 lots of buying, and then the best went to 121. **Right.**
6. **Eaten, TLKM bid 2180 (first draft of the rule).** The event fired 27 s after the level left, once enough trades had built up in the window. **Late.** Fix, now in the script: eaten is judged only on the frame where the level leaves. It now fires at 09:01:20.847.
7. **Pulled, FOLK bid 107, 09:20:39.** Two adds of 40,000 lots took the level from 31,272 to 111,276. One second later it was back at 31,422, with no trades at 107. **Right.**
8. **Pulled, BBNI bid 3610, 14:04:16.** The level fell from 33,789 lots and 77 orders to 5,289 lots and 76 orders, with no trades: one order of about 28,500 lots left. **Right.** The order count is what makes this readable.
9. **Pulled, KOTA offer 72, 09:24:01 (approached).** The offer was the touch at about 300,000 lots. 67,555 lots traded (24%), then the level was gone and the best went to 73. **Plausible.** It was partly eaten and mostly cancelled as buyers arrived. It sits right at `X`.
10. **Moved, BBNI bid 3620 → 3610, 14:02:33 (change rule).** In one frame, 3620 lost 28,711 lots and 3 orders with no trades, and 3610 gained 28,531 lots and 3 orders. **Right.** The whole-level rule calls this a pull at 3620 and a separate appearance at 3610.
11. **Appeared, FOLK bids 101, 100, 99 and 98, 09:17:34–09:17:51.** Each level gained exactly 50,000 lots and one order, all within 17 s. At 09:18:15 the 100 bid was pulled. **Right**: one actor layering bids.
12. **Reloaded (overflow, crowd), TLKM bid 2220, 14:13:00.** The level showed 619 lots in one order, and 1,896 lots of selling traded in 0.5 s while 2220 stayed best. It then refilled to 10,000 lots. **Right.**
13. **Reloaded (overflow, crowd), KOTA offer 71, 09:11:11.** The offer showed 1,923 lots, and 42,982 lots traded within 0.5 s. The best offer was flipping between 71 and 72 several times a second. **Plausible but fragile**: a few hundred milliseconds of timing error would change the reading (see below).

The day also had TLKM offer 2170 absorbed at 09:01:04.6 and eaten 0.4 s later. Both are true, but the readout should show them together, not as a contradiction.

## How much the served book's single time blurs the ledger

Recorded days keep one `at` per served book: the later of the two sides' times. A delta that carries only bids has the bid side's own time. A delta that carries both sides hides the earlier side's time.

- **Side frames with a hidden time:** 50% of all side frames (39,620 of 79,009) come from deltas that carry both sides. That is 66% on KOTA and about 12% on quiet codes.
- **Size of the uncertainty:** the hidden time lies between the previous delta's `at` and this one's: median 352 ms, p90 962 ms, p99 4.4 s.
- **Effect on events:** I reran the replay with those frames moved to the earliest time they could have, as a bound. 216 events matched within 2 s. 111 appeared only with `at`, and 67 only with the earliest time.
  - **Eaten** is most affected (92 events lost). A level leaves after the trades that took it, so pulling its frame earlier drops those trades. This suggests `at` is close to the real time for eaten.
  - **Reloaded overflow** gains 30 spurious events. It reads a single interval, so a few hundred milliseconds moves trades across frames.
  - **Absorbed, appeared and pulled** change little, because they are summed over the window or have no trades.
- **Conclusion:** recorded days before the per-side time change replay roughly. Single-interval verdicts, such as overflow reloads and eaten timing, can differ by up to about a third of events. Keeping each side's own `at` and `sequence_number` (#497) removes this.

## Method

- **`fetch.mjs`** caches book chunks per code and minute, and the whole-market tape. The tape is split into 30 s segments, each walked backwards 200 trades at a time and deduplicated by `tradeNumber`.
- **`replay.mjs`** rebuilds each side's frames from the chunk deltas. A delta with `bids` is a bid frame at the delta's `at`. It then runs every rule on each side frame over the trailing 30 s:
  - **Ledger:** `hit(p)` sums sell-aggressor lots at bid `p`, or buy-aggressor lots at offer `p`, between frame times (millisecond precision). Book and trade times agree: the BBCA offer at 5550 dropped by 114 lots 343 ms after a 114-lot buy.
  - **Absorbed:** a best-3 level at the window's start, present in every frame since, took trades of at least `k` × its start lots, with the traded value at least the floor, and no trade beyond its price.
  - **Eaten:** a best-3 level or wall in the previous frame is absent now (still in view), the window's trades at it are at least the share × its peak, and the peak value is at least the floor.
  - **Reloaded:**
    - Overflow: the best stayed best and traded more than it showed in one interval.
    - Refill: the best was hit down by half or more (trades explain half the drop or more), then refilled to half its earlier lots or more, within 2 intervals.
    - Tag: **single** when one order or fewer was added, **crowd** otherwise.
  - **Wall:** at least `m` × the median lots of its side's levels in that frame, and at least the wall floor.
  - **Appeared:** a level became a wall, at least half of its lots were added in that interval, and it was in view before.
  - **Pulled:** a wall lost half or more over 1–2 intervals, stayed in view in every frame, had no trade beyond its price, and trades explain less than `X`. The distance is in ticks from its side's best, using the tick table. It is flagged "approached" when it is within 3 ticks and closer than when the wall formed.
  - **Moved:** a pull whose loss is matched by an arrival elsewhere on the same side within ±2 frames, using the change rule above.
  - **Repeats:** an event repeats for the same kind, side and price at most once per 30 s.
- **`sweep.mjs`** prints rates per class (`SETS` for parameter sets, `SPANS` for windows, `PER=1` for per code).
- **`spot.mjs`** prints events frame by frame.
- **`blur.mjs`** measures the side-time blur.

## Limits

- **One day.** 2026-11-17 was calm after the open: BBCA's and BBRI's touch did not move after 09:15. A trending day will produce more eaten and absorbed events. The peak minutes at the open (5–7 events) are the best guide to a busy day's upper end.
- **Few wall events.** There were 14 pulls and one move, so `X`, the moved tolerance and the 3-tick approach rest on a handful of cases. The cases agree, but don't take them as rates.
- **Codes in the sample.** 15 codes, chosen by trade count. Special Monitoring Board codes have no book (#497).
- **No resets.** There was no relay gap or provenance switch in the windows. The replay does not reset the ledger, and the served deltas carry no `provenance` field.
- **Refill size.** The single/crowd tag for a refill does not yet check that the refill is close to the previous refill's size, which #491's "single" asks for.

## Rerun

The scripts are kept in `book-event-thresholds/` as `.mjs.txt`, so the repo's lint and dead-code checks skip them. Copy each back to `.mjs` to run it.

You need the session cookie value in a file (see `docs/agents/production-reads.md`).

```sh
node fetch.mjs <cookieFile> 2026-11-17 <cache> 09:00-09:30,14:00-14:30 TLKM,BBRI,KOTA,BBCA,FOLK,GOTO,BBNI,AKRA,MEDC,DSSA,SMGR,ERAA,TAPG,PANI,PNBN
SPANS=09:00-09:15 PER=1 node sweep.mjs <cache>
SETS='[{"k":1.5},{"m":3,"wallFloor":0}]' node sweep.mjs <cache>
node spot.mjs <cache> pulled 5
node blur.mjs <cache>
```
