# Order flow event thresholds, tuned on recorded days

Wayfinder task [#599](https://github.com/apinrdw/kumora/issues/599), under map [#593](https://github.com/apinrdw/kumora/issues/593). It picks the defaults for the three order flow events: Exhaustion ([#595](https://github.com/apinrdw/kumora/issues/595)), Delta divergence ([#596](https://github.com/apinrdw/kumora/issues/596)) and Failed break ([#597](https://github.com/apinrdw/kumora/issues/597)). It follows [#508](https://github.com/apinrdw/kumora/issues/508) (`docs/research/book-event-thresholds.md` on branch `research/book-event-thresholds`). Absorption is the existing Absorbed book event ([#594](https://github.com/apinrdw/kumora/issues/594)) and is not retuned here.

## The numbers

Every starting value holds. At these values a busy code gets about one order flow event every 90 minutes outside the open, far under the target of one per 10 minutes, and the market-wide feed after the open averages 1.7 events a minute. Two things the thresholds can't fix are in [Surprises](#surprises): a pile-up at the session's first Exhaustion check, and a recurring relay gap that blocks most afternoon Delta divergences.

| Threshold | Default | Why |
| --- | --- | --- |
| Exhaustion push length | **5 minutes** | At 3 or 8 minutes, busy-code rates change by 10% or less. 5 matches the 5-minute push the owner described, and the first check comes at 09:05. |
| Exhaustion lots ratio | **½** of the push's busiest minute | Almost inert. At ⅓, busy codes lose 1–6% of events, and at ⅔ they gain 2–3%. In 54% of busy events the latest minute traded under a tenth of the busiest push minute's lots, so any ratio from ⅓ to ⅔ passes them. |
| Exhaustion range ratio | **½** of the push's widest minute | This is the lever. At ⅓, busy events fall by two thirds (0.63 → 0.21 an hour after the open). Ranges are whole ticks and usually small, so ⅓ mostly turns "2 ticks, then 1" into "2 ticks, then 0". At ⅔, nothing changes. Keep ½. If the owner wants fewer events, use the push minimum below instead. |
| Exhaustion "near" distance | **2 ticks** | At 1 tick, open events fall by 16% and later ones by 6%. At 3 ticks, they rise by 9% and 2%. No reason to move it. |
| Exhaustion floor | **Rp100 M** on the busiest push minute's aggressor value | Busy codes barely notice it: at Rp250 M they lose 3–6%. It decides mid and quiet codes: at Rp250 M, mid codes lose 36% after the open (46% at it) and quiet codes 73%. At Rp50 M, quiet codes nearly double. Rp100 M matches the book events' floor. |
| Divergence gap | **10 minutes** | At 5 minutes, busy-code events at the open rise by half (0.10 → 0.15 an hour), with no change after the open. At 20 minutes, the open's events nearly vanish (0.02), because most open divergences compare against the auction high or a 09:0x high. |
| Divergence pullback | **3 ticks** | At 2 ticks, rates rise slightly. At 5 ticks, they fall by 40–60%. 3 ticks separates the two highs without losing the cases on cheap codes, where 3 ticks is a few percent. |
| Divergence margin | **Rp100 M** | Busy codes don't notice it: their cumulative delta moves by tens of thousands of lots, so a disagreement is always over Rp250 M. For mid and quiet codes, it keeps the event off small disagreements: at 0, quiet events at the open rise sixfold (0.01 → 0.06 an hour). |
| Failed break level age | **10 minutes** | At 5 minutes, busy-code events at the open double (0.10 → 0.23 an hour) because the 09:0x highs become levels by 09:10. At 20 minutes, open events nearly vanish. Keep 10, which matches Divergence. |
| Failed break distance | **1 tick** (confirmed) | 79 of 121 failed breaks went exactly 1 tick past the level, and 25 went 2. At 2 ticks, busy-code events fall by three quarters or more. A 1-tick poke with Rp100 M behind it is the most common real case. |
| Failed break value | **Rp100 M** beyond the level | At 0, mid-code events rise about fivefold, and quiet codes go from none to 0.04–0.07 an hour. At Rp250 M, busy events lose a quarter to a third. Rp100 M is the shared floor. |
| Failed break return | **3 minutes** | At 2, busy events after the open halve. At 5, they rise by half. Only 13% of breaks of an aged level come back inside within 3 minutes. The rest held. |

Unchanged from the decisions: checks run at each closed one-minute candle in continuous trading, the day's high and low include the auctions, and cumulative delta runs all day.

**Proposed, not adopted (owner's call):** the push's widest minute must span at least **3 ticks**. 61% of busy-code Exhaustions have a widest push minute of 2 ticks, then a 1-tick latest minute. 60% fire on the minute right after the extreme was set. They read as "the minute after a new high was quieter" more than "the push slowed". The minimum cuts busy events after the open from 0.63 to 0.15 an hour, and the market feed from 1.71 to 0.51 a minute. `minWidest` in `replay.mjs` measures it.

## Event rates at these numbers

The data is five sealed days, 2026-11-19, -18, -17, -16 (Monday to Thursday) and 2026-11-13 (Friday), all shares (warrants, rights and indices are skipped). Tiers are set each day by the day's regular-board value:

- **Busy:** the top 50 by value. Rank 50 traded Rp32–48 billion.
- **Mid:** ranks 51–200. Rank 200 traded Rp2.5–3.4 billion.
- **Quiet:** the rest with at least 100 trades and Rp1 billion: 83–113 codes a day.
- **Not counted:** about 900 codes a day under that. They still count toward the market-wide feed, where they add little: 150 of the 3,503 events.

The table gives events per code per hour, high side + low side, averaged over the tier. "Open" is an event on a candle labelled 09:00–09:29. "Rest" is all other continuous minutes of Sessions 1 and 2 (290 minutes Monday to Thursday, 230 on Friday).

| Window | Tier | Exhaustion | Delta divergence | Failed break | Total an hour | Total per 10 min |
| --- | --- | --- | --- | --- | --- | --- |
| Open 09:00–09:29 | busy | 2.98 (1.83 + 1.15) | 0.10 (0.10 + 0.01) | 0.10 (0.04 + 0.06) | **3.19** | 0.53 |
| | mid | 1.53 (0.89 + 0.64) | 0.05 (0.04 + 0.01) | 0.03 (0.01 + 0.02) | **1.61** | 0.27 |
| | quiet | 0.38 (0.19 + 0.19) | 0.01 (0.01 + 0.00) | 0.00 | **0.39** | 0.07 |
| Rest | busy | 0.63 (0.26 + 0.37) | 0.02 (0.02 + 0.00) | 0.04 (0.02 + 0.02) | **0.69** | 0.11 |
| | mid | 0.33 (0.18 + 0.15) | 0.01 (0.01 + 0.00) | 0.01 (0.01 + 0.00) | **0.35** | 0.06 |
| | quiet | 0.11 (0.05 + 0.06) | 0.00 | 0.00 | **0.12** | 0.02 |

- **Busy codes stay readable.** The busiest busy code-day had 11 events outside the open (0.4 per 10 minutes), and the 90th percentile had 7. The target of at most 1 per 10 minutes is met with room to spare.
- **Exhaustion is 94% of all events.** Delta divergence and Failed break fire about once per busy code every two to three days.
- **Market-wide feed:** 7.5 events a minute at the open (6.2–9.7 by day) and 1.7 a minute after it (1.4–2.1). After the open, the 95th-percentile minute has 6 events, and the busiest had 10–18 (11-17 13:39, at Session 2's first checks).
- **The open's first check is not readable:** 115, 70 and 69 events on the 09:05 candle of 11-19, 11-18 and 11-17 (see [Surprises](#surprises)).

Days and relay gaps (WIB, each a few seconds unless noted). A minute a gap touches is skipped by every window that contains it:

- 2026-11-19: 10:23, 10:25, 11:07 (34 s), 13:31, 15:31.
- 2026-11-18: 09:19, 10:34, 13:31, 15:24, 16:00.
- 2026-11-17: 11:12, 11:36, 13:31, 15:11, 16:00.
- 2026-11-16: 09:01, 09:39 (29 s), 13:31, 14:01. The 09:01 gap pushes the first Exhaustion check to 09:07.
- 2026-11-13: 08:58 (the whole auction minute), 09:00, 10:42, 14:48, 16:00.

## Sensitivity

One parameter changed at a time. Each cell is that kind's events per code per hour, at the open / after it. The market column counts every kind, every share, a minute, after the open. The busiest column is the busiest single minute of the five days.

**Exhaustion**

| Set | busy | mid | quiet | market a minute | busiest |
| --- | --- | --- | --- | --- | --- |
| defaults | 2.98 / 0.63 | 1.53 / 0.33 | 0.38 / 0.11 | 1.71 | 115 |
| lots ⅓ | 2.81 / 0.62 | 1.48 / 0.32 | 0.38 / 0.11 | 1.69 | 110 |
| lots ⅔ | 3.06 / 0.64 | 1.57 / 0.33 | 0.38 / 0.11 | 1.72 | 117 |
| range ⅓ | 0.87 / 0.21 | 0.91 / 0.24 | 0.34 / 0.09 | 1.10 | 54 |
| range ⅔ | 3.17 / 0.64 | 1.57 / 0.34 | 0.39 / 0.11 | 1.75 | 119 |
| push 3 | 2.77 / 0.57 | 1.39 / 0.28 | 0.32 / 0.09 | 1.49 | 74 |
| push 8 | 2.69 / 0.65 | 1.56 / 0.36 | 0.39 / 0.12 | 1.84 | 105 |
| near 1 tick | 2.51 / 0.59 | 1.31 / 0.30 | 0.35 / 0.10 | 1.59 | 79 |
| near 3 ticks | 3.26 / 0.64 | 1.63 / 0.34 | 0.39 / 0.11 | 1.75 | 134 |
| floor Rp50 M | 2.99 / 0.64 | 1.97 / 0.39 | 0.82 / 0.20 | 2.17 | 141 |
| floor Rp250 M | 2.80 / 0.61 | 0.82 / 0.21 | 0.11 / 0.03 | 1.21 | 69 |
| floor Rp500 M | 2.33 / 0.55 | 0.38 / 0.10 | 0.02 / 0.01 | 0.84 | 38 |
| *push widest ≥ 3 ticks (proposed)* | 1.42 / 0.15 | 0.54 / 0.08 | 0.14 / 0.03 | 0.51 | 69 |
| *push skips the session's first minute* | 2.62 / 0.63 | 1.35 / 0.33 | 0.31 / 0.11 | 1.70 | 70 |
| *push skips the first 5 minutes* | 1.63 / 0.62 | 0.87 / 0.32 | 0.23 / 0.11 | 1.68 | 34 |

**Delta divergence**

| Set | busy | mid | quiet | market a minute | busiest |
| --- | --- | --- | --- | --- | --- |
| defaults | 0.10 / 0.02 | 0.05 / 0.01 | 0.01 / 0.00 | 1.71 | 115 |
| gap 5 min | 0.15 / 0.02 | 0.06 / 0.01 | 0.01 / 0.00 | 1.71 | 116 |
| gap 20 min | 0.02 / 0.02 | 0.01 / 0.01 | 0.00 / 0.00 | 1.70 | 115 |
| pullback 2 ticks | 0.10 / 0.03 | 0.06 / 0.01 | 0.02 / 0.01 | 1.73 | 115 |
| pullback 5 ticks | 0.06 / 0.01 | 0.02 / 0.00 | 0.01 / 0.00 | 1.68 | 115 |
| margin Rp50 M | 0.10 / 0.02 | 0.05 / 0.01 | 0.02 / 0.01 | 1.72 | 115 |
| margin Rp250 M | 0.10 / 0.02 | 0.02 / 0.01 | 0.00 / 0.00 | 1.69 | 115 |
| margin 0 | 0.10 / 0.02 | 0.08 / 0.01 | 0.06 / 0.01 | 1.79 | 115 |
| *compare across relay gaps* | 0.14 / 0.06 | 0.06 / 0.04 | 0.02 / 0.01 | 1.85 | 115 |

**Failed break**

| Set | busy | mid | quiet | market a minute | busiest |
| --- | --- | --- | --- | --- | --- |
| defaults | 0.10 / 0.04 | 0.03 / 0.01 | 0.00 / 0.00 | 1.71 | 115 |
| age 5 min | 0.23 / 0.05 | 0.07 / 0.01 | 0.00 / 0.00 | 1.73 | 116 |
| age 20 min | 0.02 / 0.03 | 0.01 / 0.01 | 0.00 / 0.00 | 1.70 | 115 |
| return 2 min | 0.09 / 0.02 | 0.02 / 0.01 | 0.00 / 0.00 | 1.68 | 115 |
| return 5 min | 0.16 / 0.06 | 0.05 / 0.02 | 0.00 / 0.01 | 1.76 | 115 |
| value Rp50 M | 0.12 / 0.04 | 0.04 / 0.02 | 0.00 / 0.01 | 1.74 | 115 |
| value Rp250 M | 0.07 / 0.03 | 0.02 / 0.00 | 0.00 / 0.00 | 1.67 | 115 |
| value 0 | 0.16 / 0.06 | 0.14 / 0.05 | 0.07 / 0.04 | 2.10 | 115 |
| 2 ticks past | 0.02 / 0.01 | 0.01 / 0.00 | 0.00 / 0.00 | 1.66 | 115 |

Italic rows are rule changes, not in the decisions, measured to explain the surprises below.

**Where each rule's checks drop out (busy codes, five days, `funnel.mjs`):**

- **Exhaustion:** 2,620 latest minutes followed a push that set the extreme and hadn't fired at it. Of these, 88% were near, 88% had dried up, 57% had slowed and 97% passed the floor. 1,102 fired. Slowed is the only test that often decides.
- **Delta divergence:** 322 new extremes had an earlier one at least 10 minutes back with no gap between, and 156 of those had pulled back 3 ticks. 36 fired.
- **Failed break:** 684 breaks of an aged level, 92 came back inside within 3 minutes, and 57 had Rp100 M beyond.

## Surprises

1. **The first Exhaustion check of the day piles up.** The 09:05 candle (it closes at 09:06, the first time a full push exists) fired 115 events on 11-19 and about 70 on 11-17 and 11-18. That is 5–10 times any later minute. On 11-16 and 11-13 a relay gap moved the pile to 09:07 (27) and 09:06 (53). The cause is structural, not a threshold: the opening auction prints one price, so the first minutes of continuous trading set both the day's high and low for nearly every code, with the day's biggest volume and widest ranges. Any quieter minute after that passes. Up to 9 codes fired both sides on the same minute. No threshold in range fixes it: the 1-tick "near" still leaves 79, and Rp500 M still leaves 38. Options for the spec ([#598](https://github.com/apinrdw/kumora/issues/598), [#600](https://github.com/apinrdw/kumora/issues/600)): let the radar feed group a minute's events per kind, or keep the session's first minutes out of the push (the session's first minute leaves 70, the first 5 leave 34).
2. **A relay gap at 13:31:05 every Monday to Thursday blocks most afternoon Delta divergences.** On all four days the relay lost about 3 s at 13:31:05, at Session 2's start. "Never compare across a relay gap" then rejects every pair of a morning high and an afternoon high. Comparing across gaps would triple busy-code divergences after the open (0.02 → 0.06 an hour). That is the afternoon retest the owner kept by allowing highs in different sessions. Two fixes for the spec: count a gap only when it could have changed cumulative delta by more than the margin, or find and fix the cause of the 13:31 drop. The same gap delays Session 2's first Exhaustion check to the 13:37 candle.
3. **Most Exhaustions are the minute right after a new extreme, on 1–2-tick ranges.** See the proposed push minimum above. The dried-up test almost never decides: the minute that set the extreme is usually the push's busiest, and the next minute trades a tenth of it.
4. **Delta divergence at the low is almost absent.** In five days, busy codes had 1 at the low and 35 at the high (mid codes 12 and 40). Four of the five days fell. On a falling day, sellers drive each new low, so cumulative delta at a new low is lower, not higher. On a rising day the mirror should hold. A single rising week would show whether the low side ever fires.
5. **Candles recorded on 2026-11-16 and earlier carry 0 for `buyValue` and `sellValue`.** The replay takes aggressor value from footprints (lots × 100 × price), which matches the candle's figure exactly on 11-17 to 11-19. The spec's code should do the same, or not rely on those fields for old days.

## Examples

Each is a busy code, outside the open unless noted. The time is the WIB candle the event is judged on: it fires when that candle closes. `spot.mjs` prints these.

**Exhaustion**

1. **KOTA, 2026-11-16, 15:02.** Buying exhaustion at the day's high 67 (set 15:00) · buy-aggressor lots 431,445 (15:00, Rp2,831 M) → 102,319 a minute · range 3 → 1 ticks · at the high. Checked on the candles: 15:00 went 64 → 67, and 15:02 traded 66–67.
2. **AADI, 2026-11-19, 10:50.** Selling exhaustion at the day's low 9,925 (set 10:49) · sell-aggressor lots 4,326 (10:46, Rp4,324 M) → 198 a minute · range 2 → 1 ticks · at the low. Typical of the "minute after" case in Surprise 3.
3. **BRPT, 2026-11-13, 14:29.** Buying exhaustion at the day's high 820 (set 14:28) · buy-aggressor lots 125,054 (14:26, Rp9,984 M) → 6,117 a minute · range 4 → 2 ticks · 2 ticks from the high.
4. **WIFI, 2026-11-18, 15:00.** Selling exhaustion at the day's low 765 (set 14:57) · sell-aggressor lots 18,840 (Rp1,446 M) → 525 a minute · range 1 → 0 ticks · at the low.
5. **CSMI, 2026-11-19, 09:09 (open).** Selling exhaustion at the day's low 288 (set 09:08) · sell-aggressor lots 115,993 (09:04, Rp3,896 M) → 46,163 a minute · range 17 → 5 ticks · 2 ticks from the low.

**Delta divergence**

1. **FOLK, 2026-11-17, 10:57.** New high 117 · cumulative delta +455,946 lots vs +482,161 at 10:45's high 116 · gap Rp307 M · pulled back to 112 (4 ticks) at 10:51. Checked: 10:46 and 10:50 had 44,000 and 51,000 lots of selling, which the 10:55–10:57 buying didn't make up.
2. **KOTA, 2026-11-19, 09:33.** New high 62 · cumulative delta −109,324 lots vs −50,283 at 09:01's high 61 · gap Rp366 M · pulled back 3 ticks.
3. **TRIN, 2026-11-17, 10:25.** New high 167 · cumulative delta −135,081 lots vs −82,753 at 09:15's high 165 · gap Rp874 M · pulled back 16 ticks.
4. **ADRO, 2026-11-19, 09:32.** New high 2,370 · cumulative delta −13,417 lots vs 0 at the opening auction's high 2,360 · gap Rp3,180 M. The auction-high case the decision allowed.
5. **KOTA, 2026-11-16, 15:12.** New high 68 · cumulative delta +2,143,341 lots vs +2,249,235 at 15:00's high 67 · gap Rp720 M.

**Failed break**

1. **FOLK, 2026-11-17, 10:27.** Failed break of the day's high · traded to 112 past 110 (set 09:15) on Rp251 M buy-aggressor from 10:25 · closed back at 109 2 min later. Checked: 10:25 closed at 111 and 10:26 at 110 (on the level, so not yet inside), then 10:27 closed at 109.
2. **CUAN, 2026-11-19, 09:31.** Failed break of the day's high · traded to 370 past 368 (set 09:17) on Rp604 M buy-aggressor from 09:30 · closed back at 366 1 min later.
3. **ITMG, 2026-11-19, 10:46.** Failed break of the day's low · traded to 24,300 past 24,425 (set 09:03) on Rp577 M sell-aggressor from 10:44 · closed back at 24,450 2 min later.
4. **SINI, 2026-11-18, 09:47.** Failed break of the day's low · traded to 9,675 past 9,725 (set 09:25) on Rp1,258 M sell-aggressor from 09:46 · closed back at 9,775 1 min later.
5. **INET, 2026-11-16, 15:39.** Failed break of the day's low · traded to 184 past 185 (set 15:18) on Rp125 M sell-aggressor · closed back at 186 in the same minute. The one-minute wick the decision counts.

## Interpretation choices

Where one-minute candles leave a rule open, the replay takes the reading closest to the decision's text:

1. **Continuous minutes** are 09:00–11:59 and 13:30–15:49 (Friday: 09:00–11:29 and 14:00–15:49), from `packages/relay/src/schedule.ts`. The one-second minute at 12:00:00 (11:30:00 Friday) is left out. The auction candles (08:58, 16:00) and post-trading count only toward the day's high and low.
2. **Setting the day's high** means trading strictly above it. Equalling it doesn't set it, and doesn't rearm "once per extreme".
3. **Exhaustion (a), "one push minute set the day's high":** the minute holding the day's high when the check runs is one of the 5 push minutes.
4. **The push's busiest minute** is the one with the most aggressor lots of the side. The floor tests that minute's aggressor value.
5. **Aggressor value** comes from footprints, as lots × 100 × price (see Surprise 5).
6. **Ranges in ticks** use the tick table, counting each band's own tick across a band edge (`ticksBetween` in `packages/relay/src/ticks.ts`).
7. **A minute with no trades** has 0 lots, and its high and low are the last price, so its range is 0. Push minutes with no trades count the same way.
8. **Divergence pullback** is the lowest low of the minutes strictly between the two highs' minutes. Minute data can't say whether a high's own minute traded its low before or after its high, so neither high's minute counts.
9. **Cumulative delta** is the running sum of footprint buy-aggressor minus sell-aggressor lots from the day's first candle, read at each minute's close. Auction lots have no side and add nothing, so an auction high's cumulative delta is 0.
10. **The divergence margin** in lots is Rp100 M ÷ (100 × the new high's price).
11. **A new extreme on an auction minute** is not judged, but becomes the earlier extreme or the level for later checks.
12. **Ages** ("≥ 10 minutes earlier", for both Divergence and Failed break) compare candle start times, so a level set on the 10:00 candle can be broken on the 10:10 candle.
13. **A failed break starts** on the first continuous minute whose high (low) is at least 1 tick beyond a day's high (low) set 10 or more minutes earlier. Its value counts every aggressor lot at prices strictly beyond the level, from that minute through the return minute. Any trade beyond the level comes after the first one, so this matches the decision exactly.
14. **Back inside** means a close strictly below the old high (above the old low). A close on the level isn't inside.
15. **Relay gaps:** a gap touches a minute if it overlaps that minute. Exhaustion skips a window whose 6 minutes touch a gap. Divergence skips a pair with a gap anywhere from the earlier high's minute to the new high's. Failed break skips one with a gap from the break minute to the return. The day's high, low and cumulative delta carry on through a gap without resetting.
16. **Shares only.** Warrants, rights and indices are not replayed.

## Method

- **`fetch.mjs`** caches each day's code list, relay gaps, and every share's whole-day candles and footprints (one GET per code per day, gzipped on disk).
- **`replay.mjs`** builds each code's minute timeline (every candle plus every continuous minute without one), runs the day's high and low, sets and cumulative delta forward, and checks the three rules on each continuous minute. It takes a parameter set. Its extra knobs (`exh.skipFirst`, `exh.minWidest`, `div.acrossGaps`) are measurements, not part of the decisions.
- **`sweep.mjs`** prints the rate tables (`SETS` for parameter sets, `KIND` for one compact row per set).
- **`funnel.mjs`** counts how many checks reach each stage of each rule, per tier.
- **`spot.mjs`** prints events in the page's wording.

## Limits

- **Five days, mostly falling.** IHSG fell on 11-16 to 11-19 and rose 1.8% on 11-13. Divergence at the low will be undercounted until a rising week is replayed.
- **Few Divergences and Failed breaks.** There were 103 divergences and 121 failed breaks across all codes. Their rates are good to a factor of about 1.5, not to the second digit.
- **Minute granularity.** The rules are defined on minutes, so this is what the trading-day object will compute. The interpretation choices above are where a spec should state the reading.

## Rerun

The scripts are kept in `order-flow-event-thresholds/` as `.mjs.txt`, so the repo's lint and dead-code checks skip them. Copy each back to `.mjs` to run it.

You need the session cookie value in a file (see `docs/agents/production-reads.md`).

```sh
node fetch.mjs <cookieFile> <cache> 2026-11-19,2026-11-18,2026-11-17,2026-11-16,2026-11-13
node sweep.mjs <cache> 2026-11-19,2026-11-18,2026-11-17,2026-11-16,2026-11-13
KIND=exhaustion SETS='[{},{"exh":{"range":0.33}},{"exh":{"minWidest":3}}]' node sweep.mjs <cache> <days>
node funnel.mjs <cache> <days>
OPEN=0 TIERS=busy node spot.mjs <cache> <days> failedBreak 5
```
