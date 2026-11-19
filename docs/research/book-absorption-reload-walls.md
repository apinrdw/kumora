# How to detect absorption, reload and walls from aggregated price levels and the tape

Research for [#487](https://github.com/apinrdw/kumora/issues/487), map [#485](https://github.com/apinrdw/kumora/issues/485). Written 2026-11-18.

## Short answer

All three can be read from what we have, as long as each reading is defined on a **level ledger**: for one price level on one side, between two consecutive book frames of that side, compare the lots shown with the lots the tape says traded at that price against that side. One identity holds per interval:

```
shown₁ − shown₀ = added − hit − cancelled
```

`shown` comes from the book, `hit` from the running trades. `added` and `cancelled` are both unknown, so only their difference is known. Each reading must work from bounds: `added ≥ max(0, shown₁ − shown₀ + hit)` and `cancelled ≥ max(0, shown₀ − shown₁ − hit)`. This is how the Cont–Kukanov–Stoikov order-flow-imbalance paper classifies quote changes. It treats a drop in a queue as "a market order or a cancellation" because quote data cannot tell them apart. We can tell them apart in part because we also have the tape.

| Reading | Works at our granularity? | Minimum cadence (one side) | Main false positives |
| --- | --- | --- | --- |
| **Absorption** (a level takes hits and holds) | Yes, over windows of 5–30 s | ~1–2 s per side | Trade and frame clocks misaligned at 1 s; adds and cancels netting out |
| **Reload** (a level refilled after being hit) | Yes as an event, but cannot say "iceberg" | ~1 s; a refill inside one interval shows only as overflow | Other traders joining the queue; amends; frames coalesced |
| **Wall** appeared / pulled / filled / moved | Yes for appeared, pulled and filled. Moved is a heuristic | ~1–2 s; moved needs both frames within ~2 s | The level leaving the 20-level window; a legal cancel looks like spoofing; provenance switch |

**Our data's edge:** each level carries its **order count**. Most market-by-price feeds that order-flow tools use carry size only. A change in orders next to a change in lots separates "one order refilled" from "many traders joined", and a wall of one to three orders from a crowd.

**Our data's main gap:** trades are stamped to the **second**, and book frames carry no trade number. Trades can only be matched to book intervals by time, with ±1 s slack. That is too coarse for a per-frame verdict. Readings should therefore add up the ledger over a window, so that trades counted in the wrong interval at a boundary cancel out.

## Our inputs, as the code has them

- **Book.** `packages/relay/src/order-book.ts`: `OrderBook` holds up to `BOOK_DEPTH` = 20 levels a side, each `{ price, lots, orders }`, plus whole-book `bidLots` / `offerLots` and one `at`. The provenance is Stockbit `order_book` or Ajaib `ORDER_BOOK_CUSTOM`.
  - Stockbit sends **one side per frame as a full snapshot**, about 45–85 levels ([`live-price-channels.md`](live-price-channels.md), section 4). The trading-day object keeps the latest frame of each side and stamps the served book with the later side's `datetime` (`apps/dashboard/src/server/market-live/order-books.ts`, `stockbitSideOf`, `build`). **Each side's own time is lost in `OrderBook`.** The raw frame also carries `sequence_number` and `itch_incoming_time`, which we drop.
  - Ajaib sends **deltas batched every 150 ms**. A level with `lot` 0 deletes that price ([`live-price-channels.md`](live-price-channels.md)).
  - Rate: an active code sends about 1.4–2.5 Stockbit book frames a second, covering both sides, so roughly one frame per side a second. Ajaib sends about 2–2.8 frames a second per code ([`broker-frame-rates.md`](broker-frame-rates.md)).
  - Recorded days keep every served book frame as per-minute chunks of changed parts (`book-chunks.ts`), so a replay sees the same frames the live page saw.
- **Tape.** `RunningTrade` in `packages/relay/src/envelope.ts` holds `tradeNumber`, `time`, `price`, `lots`, `side` (the aggressor side), `board` and `feeds`. Trade time has 1 s precision: Ajaib's `tradedAt` always has `.000` milliseconds ([`ajaib-live-data.md`](ajaib-live-data.md)). Auction matches have no aggressor side (glossary, **Aggressor side**). The tape is whole-market, but books exist only for the selected and watchlist codes.

## What the sources say

### Market microstructure

- **Order flow imbalance (OFI).** Cont, Kukanov, Stoikov, *The Price Impact of Order Book Events* ([arXiv:1011.6402](https://arxiv.org/abs/1011.6402), J. Financial Econometrics 2014). They compare consecutive best-quote observations and define the contribution `eₙ = 1{Pᴮₙ ≥ Pᴮₙ₋₁}qᴮₙ − 1{Pᴮₙ ≤ Pᴮₙ₋₁}qᴮₙ₋₁ − 1{Pᴬₙ ≤ Pᴬₙ₋₁}qᴬₙ + 1{Pᴬₙ ≥ Pᴬₙ₋₁}qᴬₙ₋₁`. A fall in the bid queue at an unchanged price is "the size that was removed from the bid, whether due to a market sell or cancel buy order." They sum `eₙ` over **10-second** intervals and find price changes linear in OFI, with a slope inversely proportional to depth. The method needs **only snapshots of aggregated levels**, not orders, and does not match trades. Our ledger is this method extended to 20 levels and split using the tape.
- **Cancellation is proportional to queue size.** Cont, Stoikov, Talreja, *A Stochastic Model for Order Book Dynamics* (Operations Research 58(3), 2010). They model cancellations at a level at a rate proportional to the orders resting there, and estimate the model from high-frequency order-book observations on the Tokyo Stock Exchange. The full-text estimator was not retrieved, only the model structure ([RePEc](https://econpapers.repec.org/RePEc:inm:oropre:v:58:y:2010:i:3:p:549-563)). For us, the lesson is that big levels lose lots to cancellation constantly. A wall that shrinks is not by itself an event.
- **Iceberg detection from public data.** Frey & Sandås, *The impact of iceberg orders in limit order books* ([CFR WP 09-06](https://www.cfr-cologne.de/download/workingpaper/cfr-09-06.pdf)), on Xetra. The rule: "if an order book contains an iceberg at the best quote then a trade that exhausts all the displayed depth at the best quote prompts an immediate addition of new depth equal to the iceberg order's peak size." The algorithm flags an iceberg after the first replenishment, tracks each price level separately, and keeps the flag until an expected replenishment fails to occur. It "compare[s] the execution records with the observed order book before each trade", which means event-level sequencing. Against Xetra's true iceberg flags, at the best ask, it falsely detects an iceberg in about **1%** of observations and misses one in **3–5%**. They also note that a detector "cannot determine the iceberg order's size although its peak size may provide a signal."
- **CME iceberg detection.** *CME Iceberg Order Detection and Prediction* ([arXiv:1909.09495](https://ar5iv.labs.arxiv.org/html/1909.09495)). This uses market-by-order data with order IDs. Native icebergs are flagged when "a trade larger than the resting volume is detected". Synthetic icebergs (a trader re-posting by hand or by algorithm) are flagged when a new order at the same price and size arrives within **dt = 0.3 s** of the previous tranche's removal. The authors admit "it is impossible to detect synthetic icebergs with varying peak sizes or price levels." Synthetic-iceberg prediction precision is about 50%.
- **Spoofing in an Asian order-driven market.** Lee, Eom & Park, *Microstructure-based manipulation: Strategic behavior and performance of spoofing traders* (J. Financial Markets 16(2), 2013, [RePEc](https://econpapers.repec.org/RePEc:eee:finmar:v:16:y:2013:i:2:p:227-252)), on the Korea Exchange with account-level data. About 0.81% of orders were spoofing orders, placed with little chance of execution to suggest an imbalance. Spoofing fell sharply after KRX changed its order-disclosure rule. They could tell spoofing apart only because they had **account identities**. Nobody outside the exchange can.

### Regulators

- **US.** CEA §4c(a)(5)(C) makes spoofing unlawful: "bidding or offering with the intent to cancel the bid or offer before execution". The CFTC's interpretive guidance is at 78 Fed. Reg. 31890 (2013), summarized by [FIA](https://fia.org/sites/default/files/2019-12/Dodd-Frank-Disruptive-Trading-Provisions-CFTC-Provides-Final-Interpretative-Guidance-052313.pdf). The offence turns on **intent**, which the book cannot show.
- **EU.** MAR Delegated Regulation 2016/522, Annex II, lists orders withdrawn before execution as indicators of "layering and spoofing". A 2026 Commission draft (C(2026) 2152, [Council doc ST-8101-2026-ADD-1](https://data.consilium.europa.eu/doc/document/ST-8101-2026-ADD-1/en/pdf)) adds a point that names the practice. These are *indicators* for regulators who see who placed the orders, not tests a public-data observer can apply.
- **IDX.** Spoofing is illegal under UU Pasar Modal art. 91 (map #485). IDX added a **non-cancellation period** from 2025-12-15, in pre-opening (from about 08:56) and pre-closing (from about 15:56). During it, orders already entered cannot be amended or withdrawn, though new orders can still be entered. IDX gave its reason as rising cancellations in the final minutes before the auction match ([Bareksa, 2024-08-08](https://www.bareksa.com/berita/saham/2024-08-08/cegah-order-fiktif-di-pasar-saham-bursa-kaji-penerapan-sistem-ini/amp); [Kontan](https://investasi.kontan.co.id/news/ingat-bei-akan-terapkan-periode-non-cancellation-mulai-15-desember-2025); exact windows differ between press reports, so **confirm** against the IDX circular). It does not touch continuous trading, where walls are read.
- **IDX iceberg orders: not found.** No source found says JATS-NextG offers an iceberg or hidden order type. Its market orders are FAK, FOK and Market-to-Limit ([VOI](https://voi.id/en/economy/380838)). If there is none, every reload on IDX is **synthetic**: someone re-posting, by hand or by algorithm. **Confirm** against IDX Rule II-A before the glossary uses "iceberg".

### Order-flow tools

- **Bookmap Iceberg Orders Tracker** ([wiki](https://bookmap.com/wiki/Iceberg_Orders_Tracker)) has three algorithms:
  - *Underflow*: a trade larger than the size shown at its price. It is now expired, because feeds no longer keep that event order.
  - *Native*: needs market-by-order data with "an untouched sequence of events".
  - *Resistance*: for market-by-price data. It flags new limit orders "being added instantly from the opposite side as a response to executions at that price level". What counts as "instantly" is configurable, and a size threshold above the default of 1 "reduce[s] the chance of false-positive detection".

  Bookmap says icebergs and their larger analogues "act as Absorption of aggressive orders", "the size of the hidden part … cannot be detected", and "any Iceberg tracker is an estimation". Resistance is the method that matches our data.
- **Footprint absorption** ([ATAS, footprint patterns](https://learn.atas.net/volume-basics/volume-analysis/footprint-patterns)): "unusually high volume at one level" where "price does not move or barely advances". No numeric thresholds are given. This is trades-only: footprint absorption never looks at the book. We already have the footprint, and the radar adds the book side, meaning what the level showed before and after.
- **Pulling and stacking** (Bookmap Marketplace and Sierra Chart; community sources only, no first-party definition found): these indicators count lots removed from and added to levels near the touch, without separating fills from cancels. Our ledger is stricter.

### Indonesian educator material

- **Stockbit Snips**, [*Bid dan Offer Saham*](https://snips.stockbit.com/investasi/bid-offer-saham): watch the largest lot count on each side. A thick bid that is eaten tends to precede a fall, and a thick offer that is eaten tends to precede a rise. Its "fake demand/supply" pattern is a price pushed up on thin volume, then a sudden thick bid, then spam orders on the running trade. It says nothing about order counts.
- **Ajaib**, *Kenapa bid tebal belum tentu harga naik* (cited in search results; the page returned 403 to the fetcher, so this is **unverified**). It works the ledger arithmetic by hand: when a 5,000-lot sell print takes a bid queue from 800,000 to 550,000 lots, the 245,000-lot gap "hilang bukan karena terserap oleh transaksi, melainkan karena order ditarik" (vanished not because trades absorbed it, but because orders were pulled). It names the tell: a giant queue cancelled just before price reaches it. Its advice is to check the running trade to see whether a queue really executed.
- **Bareksa**, [*Apa Itu Antrian Bid & Offer*](https://www.bareksa.com/berita/saham/2026-01-08/apa-itu-antrian-bid-offer-saham-dan-cara-membacanya/amp): read the consistency of a queue over time, not one snapshot, because a queue is intent, not a transaction.

The IDX educators teach the same decomposition as the literature, by eye. What they add is the pattern of a thick queue pulled as price approaches.

## Matching trades to level changes

1. **Order the frames per side.** Use each side's own frame time, not the served book's `at`, which is the later of the two sides. For Stockbit, keep `sequence_number` or `itch_incoming_time` if they prove monotonic (a follow-up). For Ajaib, the 150 ms flush order is enough.
2. **Choose the trades.** For the interval `(t₀, t₁]` on the bid, take regular-board trades of the code with **sell** aggressor side. For the offer, take **buy** aggressor trades. Skip auction matches, which have no side, and negotiated-board prints. Because trades are stamped to the second, a trade at second `s` belongs to the interval that holds `s` or the one before it.
3. **Credit each trade to its price.** On a price-time book, a sell aggressor at price `p` can only have hit bid `p`. `hit(p)` is the sum of those lots.
4. **Check the level is valid in both frames.** The level must be inside the 20-level window in both frames, and the best price must not have moved through `p` in the interval. Otherwise the level's change is **unknown**, not a cancel. Deep levels drop out of the window simply because price moved away.
5. **Compute bounds, then add them up over a window.** Per interval, compute `added ≥ …`, `cancelled ≥ …` and `overflow = max(0, hit − shown₀)`, then sum them over a rolling window (5–30 s). Summing makes trades assigned to the wrong interval at a 1 s boundary cancel. The tape's `tradeNumber` orders trades exactly within one second, but it cannot be placed between book frames.
6. **Reset on discontinuities.** Reset the ledger when provenance switches between Stockbit and Ajaib, at a gap in the frames (`gaps.ts`, `late-frames.ts`), and at a market phase change.

Cadence floor: the literature's event-level methods use millisecond sequencing (CME dt = 0.3 s; Frey–Sandås event by event), and OFI works at 10 s from quote snapshots. At roughly 1 s per side we are between the two. That is good enough to read the sums over a window, but too coarse for verdicts on single events.

## Absorption

- **Inputs:** the level ledger at the best one to three levels of a side. Over the window: `hit`, the lots shown at the window's start and end, and whether price traded through the level.
- **Minimum cadence:** about 1–2 s per side, over a window of 5 s or more. Below that, the 1 s trade clock dominates.
- **Matching:** the steps above. Absorption is `hit` summed over the window at one price.
- **False positives:** adds and cancels netting out, so the level looks steady while most of its traders were replaced. A level traded through and re-formed inside one interval, which shows up as trades beyond `p`. The 1 s misalignment at window edges. Negotiated or crossing prints, unless filtered by board.
- **At our granularity:** yes. It is better than footprint absorption, because we see the queue before and after.
- **Recommended definition:** a level **absorbed** selling (bid) or buying (offer) when, over a window `W`, the lots that traded into it are at least `k ×` the lots it showed at the window's start, and the level is still there at the end with no trade beyond its price. Report the lots absorbed, the lots still shown, and the share that left by cancellation, using its lower bound. If the level is gone and the trades cover the drop, it was **eaten**, not absorbed. `k`, `W` and a value floor are tuned on recorded days (map: "Tuning thresholds").

## Reload

- **Inputs:** the level ledger at the best level: `overflow`, the change in lots, and the change in orders. Also the passive broker per trade, on recorded days once broker codes are stored.
- **Minimum cadence:** about 1 s. A refill that happens within one interval does not show as a drop and a rise. It shows as **overflow**: more lots traded at `p` than `p` showed, while `p` is still the best price. That is Bookmap's expired *Underflow* idea and the native CME rule, both of which still work on snapshots. A refill slower than one interval shows as a drop explained by hits, then an add at the same price. That is Bookmap's *Resistance* and Frey–Sandås's replenishment.
- **Matching:** the steps above. Overflow needs only `hit(p)` and `shown₀(p)`.
- **False positives:**
  - Other traders joining the queue as it is hit, which on IDX is common at round numbers.
  - Amends that change quantity. Whether IDX keeps time priority on a quantity *increase* is not confirmed; one broker FAQ says a *reduction* keeps priority.
  - Coalesced frames.
  - Ajaib's batched deltas hiding the low point.
- **At our granularity:** yes as an event. The **order count** sharpens it. A refill that restores about the same lots with `Δorders` of 0 or +1, repeated at one price, points to one actor. A refill made of many new orders is the crowd. We cannot size the hidden remainder, and probably cannot call it an "iceberg" (see the IDX note above).
- **Recommended definition:** a level **reloaded** when, while it stayed the best price, the lots traded into it in one interval exceeded the lots it showed (overflow), or it was hit down and then refilled at the same price. Report the reload count and the lots traded beyond what was shown. Qualify each reload as **single** (`Δorders` ≤ 1 and the refill close to the previous refill's size) or **crowd** (several new orders). A reload is a kind of absorption, not a separate verdict. Do not call it "iceberg" or "hidden" on the page.

## Walls: appeared, pulled, filled, moved

- **Inputs:** every level in the 20-level window: lots, orders, and distance from the best price in ticks (tick table in map #485). The ledger supplies the pulled-versus-filled split.
- **Minimum cadence:** about 1–2 s per side. *Moved* needs the disappearance and the reappearance within about two frames.
- **Matching:** a wall's drop is filled to the extent of `hit(p)`. The rest is pulled, and it is a lower bound.
- **False positives:**
  - **A wall leaving the window** as price moves away, which is not a pull. Require the level inside both frames.
  - Price crossing the level.
  - A **legal cancel**: the book cannot show intent. Lee/Eom/Park needed account IDs, and US and EU law turn on intent. The page must say "pulled", never "spoof".
  - Re-pricing to follow the touch, which looks like moved and is ordinary.
  - A provenance switch rebuilding the book.
  - Tick-size boundaries changing what "the next level" means.
  - ARA/ARB queues (out of scope) and auction periods, where the non-cancellation period applies.
  - Steady cancellation proportional to queue size (Cont–Stoikov–Talreja). Large levels shrink by themselves.
- **At our granularity:** yes for appeared, pulled and filled, because the tape separates fills. *Moved* is a heuristic: without order IDs, it cannot be proven that the same order moved, which is the same limit the CME paper hits for synthetic icebergs.
- **Recommended definitions:**
  - **Wall:** a level whose lots are at least `m ×` the median lots of the levels on its side in the window, and at least a value floor. Show its order count: a wall of one to three orders is *concentrated*, and a wall of many is a *crowd*.
  - **Appeared:** a level became a wall within one interval, with `added` at its lower bound for most of it.
  - **Pulled:** a wall lost at least half its lots within one or two intervals while it stayed inside the window and price did not cross it, and the tape explains less than a set share of the loss. Record its distance in ticks at the time it was pulled, and whether price had been approaching it. "Pulled as price approached" means the distance shrank over the wall's life and the pull came within a few ticks.
  - **Filled:** a wall's drop is mostly explained by `hit`.
  - **Moved:** a wall was pulled at `p` and, within about two frames, a wall of similar lots (±20%) and the same order count appeared at `p′` on the same side.

## What this means for the map

- Absorption, reload and walls all hang on one primitive, the **level ledger**. That is one definition for the glossary and one computation to place, either in the trading-day Durable Object or in the browser (map: "Where the readings are computed"). The ledger needs the book frames and the tape for the same code, and the tape already covers every code.
- **Replay:** recorded days already keep every served book frame and every trade. The ledger can be recomputed on a recorded day without storing anything new, provided each side's own frame time is kept (see the follow-up).
- **Thresholds** (`k`, `W`, `m`, the share for pulled, the floors) need a measurement against recorded days, as the map already expects.

## Follow-ups

- **Keep each side's frame time, and Stockbit's `sequence_number` and `itch_incoming_time`, in the served book or the stored chunks.** Today `OrderBook.at` is the later of the two sides, so the bid's interval is wrong whenever only the offer moved. Check in a capture whether `itch_incoming_time` has sub-second precision and is monotonic per code. If it is, trades and frames can be aligned more tightly than the 1 s trade clock.
- **Confirm** two IDX facts in Rule II-A or a JATS-NextG guide: whether an iceberg or hidden order type exists, and how amending a quantity up or down affects time priority.

## Confidence

| Claim | Basis | Confidence |
| --- | --- | --- |
| OFI decomposition from aggregated snapshots | Paper text read (arXiv PDF) | High |
| Frey–Sandås rule and error rates | Working paper text read | High |
| CME rules and limits | Paper read (ar5iv) | High |
| Bookmap algorithms and limits | First-party wiki | High |
| Our cadence and fields | Repo code and earlier research notes | High; per-side cadence is about 1 s, an estimate |
| IDX non-cancellation period | Press, not the circular | Medium |
| No iceberg order type on IDX | Absence of evidence | Low |
| Ajaib 800,000 → 550,000 example | Search excerpt; page blocked | Low |
| Cont–Stoikov–Talreja estimator details | Abstract and secondary summaries only | Low (model structure only) |
