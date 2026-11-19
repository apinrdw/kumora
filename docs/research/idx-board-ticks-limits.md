# Where the Special Monitoring Board list, tick sizes and price limits come from

Research for [#488](https://github.com/apinrdw/kumora/issues/488), part of the map [#485](https://github.com/apinrdw/kumora/issues/485) (Order book radar). Read on 2026-11-18 (a Wednesday). Every claim comes from a live, unauthenticated request to `www.idx.id` on that date, or from the IDX regulation PDFs it links, unless it cites another source.

## Answer

- **Special Monitoring Board membership:** IDX's special-notation API returns every code with a notation. Notation `X` means "listed on the Watchlist Board" (Papan Pemantauan Khusus). On 2026-11-18 it returned 109 codes, 59 of them with `X`, as of the trading day 2026-11-17.

  ```
  GET https://www.idx.id/secondary/get/ListedCompanies/SpecialNotation/SpecialNotation?Language=en-us&indexFrom=1&pageSize=9999
  ```

  The page's own list of board members (`/secondary/get/SpecialMonitoringEffects/MonitoringEffectsHistorical`) agrees with it, so the radar can use either one as a check on the other. The `PapanPencatatan` field in `GetCompanyProfiles` (the #410 sector source) is **stale** for at least one code. Do not use it.
- **Tick sizes:** Peraturan II-A, section VI.5.2 (Kep-00158/BEI/10-2026). The table matches the map's note: Rp1 below Rp200, Rp2 from Rp200, Rp5 from Rp500, Rp10 from Rp2,000, Rp25 from Rp5,000. It has no end date. VI.5.4 says the tick follows the price of each order in real time, so one book can use two tick sizes when it straddles a band edge.
- **Price limits now:** Kep-00158/BEI/10-2026, issued and in force on 2026-10-20, replaced Kep-00157 (2026-10-19) after one day. Until 2026-12-31:

  | Reference price | Upper (ARA) | Lower (ARB) |
  |---|---|---|
  | Rp1–Rp10 | +Rp1 | −Rp1 |
  | Rp11–Rp14 | +35% | **−Rp1** |
  | Rp15–Rp200 | +35% | −7% |
  | >Rp200–Rp5,000 | +25% | −7% |
  | >Rp5,000 | +20% | −7% |

  The press reported "7% for everything above Rp10". The decree itself gives the Rp11–14 band a Rp1 lower limit. Special Monitoring Board codes follow their own rule (Peraturan II-X): ±Rp1 for Rp1–10 and ±10% above Rp10. The 7% change does not touch them.
- **From 2027-01-01**, unless IDX extends the transition, the permanent II-A table VI.7.1.1 applies. It is symmetric: ±35% for Rp11–200, ±25% for >Rp200–5,000, ±20% above Rp5,000, and ±Rp1 for Rp1–10.
- **Minimum price:** Rp1 on the regular, cash and negotiated markets (II-A VI.6 and VII.3; II-X II.1.4). There is no end date.
- **Relay frames:** no frame the relay receives carries a code's notation or its listing board. The `board` and `market_board` fields that it decodes are the *market* (RG regular, TN cash, NG negotiated), which is a different thing. The radar has to join the IDX list.
- **Recommendation:** a Production-only daily cron reads the special-notation API and stores `code -> notations`. The tick and limit tables are code constants, each carrying a `Decision:` comment that cites its decree and its end date. Rp1–10 codes need no list, because the radar can judge them from the live previous close.

## Special Monitoring Board membership

### Sources compared

All three were read on 2026-11-18. Each is unauthenticated JSON on `www.idx.id`, which has no Cloudflare challenge.

| Source | Members | Notes |
|---|---|---|
| `/secondary/get/ListedCompanies/SpecialNotation/SpecialNotation` (the "Notasi Khusus" page) | 59 with `X` | One row per code that has any notation: `EmitenCode`, `Notation` (`"E,X"`), `Remarks` (a 30-character positional string), `Date`, and `Description`. `GetNotationLatestDate` returned `2026-11-17T15:00:00`, so the data runs one trading day behind. Also reachable at `/primary/ListedCompany/GetSpecialNotation?start=0&length=9999`, which returns the same rows. |
| `/secondary/get/SpecialMonitoringEffects/MonitoringEffectsHistorical?startDate=20200101&endDate=<today>&View=Export&length=9999&start=0` (the "Efek Pada Papan Pemantauan Khusus" page) | 59 open rows (`TanggalKeluar: null`) | One row per entry: `Kode`, `Nama`, `Kriteria` (`"2, 5"`), `TanggalMasuk`, `TanggalKeluar`. `View=Table` filters by entry date, so a 3-year window missed `CMPP` (in since 2022-05-31). Use a start date before 2021. 467 rows of history. |
| `GetCompanyProfiles` `PapanPencatatan == "Watchlist"` (and `GetSecuritiesStock` `ListingBoard`) | 60 | Includes `BRRC`. The history shows BRRC entered on 2025-02-03 and left on 2025-02-12. It has no `X` notation, it traded 2.8M shares on 2026-11-17, and its `Remarks` board digit reads Development. The profile field is stale. |

The first two sources match exactly: the same 59 codes.

### The notation legend

The Notasi Khusus page content (`/primary/page/id/perusahaan-tercatat/notasi-khusus`) lists B, M, E, D, L, A, S, C, Q, Y, F, G, V, N, K, I and X. Only `X` marks the board. The other notations flag a financial or legal condition: E is negative equity, L is a late report, M is PKPU, B is bankruptcy, and so on. A code can carry such a notation and still trade on a regular board. On 2026-11-17 the counts were X 59, L 51, Y 48, E 46, M 13, S 10, D 8, F 8, B 4, A 3, N 2 and I 1.

The page content for Papan Pemantauan Khusus (`/primary/page/id/perusahaan-tercatat/daftar-efek-pemantauan-khusus`) lists the entry criteria from Peraturan I-X. Criteria 1, 6, 7 and 10 now read "Dihapus" (deleted). The other criteria cover a disclaimer opinion (2), no revenue (3), a pre-revenue miner (4), negative equity (5), PKPU or bankruptcy of the company (8) or of a material subsidiary (9), and other conditions set with OJK approval (11).

### A second check inside a feed IDX already serves

`/primary/TradingSummary/GetStockSummary?length=9999&start=0&date=YYYYMMDD` (the daily stock summary, 945 rows for 2026-11-17) carries the same 30-character `Remarks` per code. Position 30 (index 29) is `X` for exactly the 59 codes, and positions 19–30 matched the notation API on every code. Position 5 looks like the listing board: `1` for AADI (Main), `2` for BRRC (Development), and `4` for every `X` code. That reading is inferred from the data, and IDX documents no layout for the field. The summary for the current day is empty until the evening (it returned 0 rows for 2026-11-18 during the session), so it is a fallback, not the main source.

### How often it changes

`GetAllAnnouncement?keywords=pemantauan%20khusus` returns 748 announcements. From 2026-07-24 to 2026-11-13 there were 60 of them, often several a week: placements (`Peng-PK-*`), removals (`Peng-CK-*`), and criteria changes (`Peng-UK-*`). The `Code` field is blank, and the PDFs sit behind a Cloudflare challenge on `idx.co.id` (HTTP 403 for curl and WebFetch), so the announcements cannot serve as a machine-readable source. A daily read of the notation API is enough, because a placement takes effect on a later trading day and the API lags by one day.

### What the relay already receives

- **Stockbit `liveprice`** (`apps/dashboard/src/server/market-live/stockbit-liveprice.ts`): field 23 `board` is `BoardType` RG/TN/NG, the market segment. The field table in [live-price-channels.md](live-price-channels.md) has no notation or listing-board field.
- **Stockbit trades** (`market_board`) and **Ajaib `TRADE`** (`market_type`): both decode to `Board` RG/TN/NG (`packages/relay/src/envelope.ts`).
- **Stockbit `iepiev`** (`indicative.ts`): code, price, volume and time only.
- **Ajaib `PRICE`** (`ajaib-price.ts`): price fields only.
- **Order books** (`packages/relay/src/order-book.ts`; Stockbit `#O|SYM|BID` text and Ajaib `ORDER_BOOK_CUSTOM`): price, lots and orders per level only.
- **Ajaib `/v1/stock/data/list/`** (`packages/relay/src/code-list.ts`): the relay decodes only `code` and `name`. Whether the raw body holds more fields is unrecorded. [ajaib-live-data.md](ajaib-live-data.md) lists this as a DevTools question ("whether it includes suspended and special-notation codes"). It could also be an `X` source, but IDX's own list is primary and needs no session.

### Does a Special Monitoring Board code have a book?

The map's note says these codes "show no bid or offer, only IEP/IEV". Peraturan II-X says only that JATS shows IEP and IEV during order entry (II.1.10) and that trading runs as Periodic Call Auction (II.1.2). It does not say the book is hidden. In IDX's own summary for 2026-11-17, the 7 `X` codes that traded had end-of-day Bid and Offer prices (GIAA 48/49, FLMC 156/158). The other 52 did not trade. Whether Stockbit's `order_book` or Ajaib's book stream sends levels for these codes during a call auction is unverified. The radar excludes them by list either way, so this does not block the spec.

## Tick sizes (fraksi harga)

Source: Peraturan II-A, Lampiran Kep-00157/BEI/10-2026 as amended by Kep-00158/BEI/10-2026, section VI.5. The PDF is `https://www.idx.co.id/Media/stumk2gi/signed_peraturan_nomor_ii_a_tentang_perdagangan_efek_bersifat_ekuitas-261020.pdf`, which is also served without a challenge at the same path on `www.idx.id`. It is listed by `GET https://www.idx.id/primary/Regulation/GetTradingRegulations?pageSize=100&indexFrom=0&lang=id`.

| Price | Tick | Maximum step per order change |
|---|---|---|
| < Rp200 | Rp1 | Rp10 |
| Rp200 to < Rp500 | Rp2 | Rp20 |
| Rp500 to < Rp2,000 | Rp5 | Rp50 |
| Rp2,000 to < Rp5,000 | Rp10 | Rp100 |
| ≥ Rp5,000 | Rp25 | Rp250 |

- VI.5.2 states the bands in terms of the "Harga Previous". VI.5.4 then says the tick and the maximum step change "secara seketika (real time)" with the price of the order entered. So the tick at a level depends on that level's price. Spread in ticks across a band edge (for example 498 bid, 500 offer) has to count Rp2 steps below 500 and Rp5 steps from 500.
- The table applies on the regular and cash markets. The maximum step does not apply to warrants (VI.5.3) or to call-auction trading on the Special Monitoring Board (II-X II.1.6).
- Round lot: 100 shares (VI.4.2).

## Auto-rejection limits

### Now (2026-10-20 to 2026-12-31)

Source: Kep-00158/BEI/10-2026, issued and in force on 2026-10-20, points 2 and 3. It revoked Kep-00157 of 2026-10-19 (point 4). The reference price (Acuan Harga, VI.7.3) is the previous close, the theoretical price after a corporate action, the IPO price on a listing day, or an appraiser's fair value.

| Reference price | Rejected if above | Rejected if below |
|---|---|---|
| Rp1–Rp10 | reference + Rp1 | reference − Rp1 |
| Rp11–Rp14 | reference + 35% | reference − Rp1 |
| Rp15–Rp200 | reference + 35% | reference − 7% |
| >Rp200–Rp5,000 | reference + 25% | reference − 7% |
| >Rp5,000 | reference + 20% | reference − 7% |

There is also an absolute floor: any price below Rp1 is rejected (VI.7.1.1.1 and VI.6).

Press coverage (CNBC Indonesia, Bisnis, Kontan, 2026-10-19 and 2026-10-20) describes "7% for all prices above Rp10" and cites only Kep-00157. The Rp11–14 carve-out comes from Kep-00158 a day later. At those prices 7% is less than one tick, so it makes sense. Take the decree over the press.

The decree is temporary. It cites OJK's letters S-135/D.04/2026 and S-136/D.04/2026 under POJK 13/2023, the rule for a market that fluctuates significantly. Point 2 says the permanent percentages of VI.7.1.1 are "belum diberlakukan sampai dengan 31 Desember 2026". IDX can extend or change this with a new Kep, as it did twice in October. Watch `GetTradingRegulations` for a newer II-A entry.

### Permanent table (from 2027-01-01 unless extended)

II-A VI.7.1.1.2–5: ±Rp1 for Rp1–10, ±35% for Rp11–200, ±25% for >Rp200–5,000, and ±20% above Rp5,000.

### Before 2026-10-19

Kep-00136/BEI/09-2026 (in force 2026-09-28) set the floor to Rp1 and used 35/25/20% up and 15% down above Rp10. That decree is now revoked. This history comes from the press (Kontan, Metro TV, CNN Indonesia) and was not read from the decree.

### Special Monitoring Board

Peraturan II-X (Kep-00140/BEI/09-2026, in force 2026-09-28), II.1.5: ±Rp1 for Rp1–10, ±10% above Rp10, and a Rp1 floor. II-X otherwise defers to II-A (II.1), so the tick table applies. Trading runs as Periodic Call Auction: five sessions Monday to Thursday, with random end times and no-change windows, plus a post-close session at the last price. Kep-00140 point 2 defers the new Non-Cancellation Period until IDX's trading-system replacement (PSPP) goes live.

### Warrants and others

Warrants (VI.7.1.3) have their own percentages: 50% for Rp10–200, 40% for >Rp200–5,000, and 30% above Rp5,000. On a warrant's first day, its price cannot reach its underlying stock's price. Rights (HMETD) are exempt except for the Rp1 floor (VI.7.4). DINFRA has its own rule (II-O, Kep-00137/BEI/09-2026). An order of more than 50,000 lots or 5% of listed shares, whichever is smaller, is rejected too (VI.7.2).

## How Kumora would use this

1. **Board list.** A Production-only daily cron, gated like the other IDX crons in `apps/dashboard/alchemy.run.ts`, reads the special-notation URL once after the evening close. Keep `code`, the notation letters and `Date`. Validate before replacing: the response must parse, and the `X` count must not fall to zero or drop sharply from yesterday's. Otherwise keep yesterday's list. Serve it as a cached `code -> notations` map, or join it into the code list the trading-day object serves. The radar excludes `X` codes and can show the notation's meaning in the readout's "no readings" reason.
2. **Rp1–10 codes.** No list is needed. Use the live previous close or last price from `liveprice`. On 2026-11-17, five codes closed at Rp10 or below.
3. **Ticks and limits.** Encode them as pure functions in a shared package: `tickAt(price)` and `limitsFor(reference, board, date)`. Each table carries a `Decision:` comment that cites the Kep number and its validity window. The limits function switches on the date, so the 2027-01-01 change needs no deploy if IDX lets the transition lapse. A new Kep needs a code change. That is acceptable at a few changes a year, and a source-of-truth check (below) catches it.
4. **Drift check.** Optionally, a cheap weekly job can read `GetTradingRegulations` and alert when the newest II-A or II-X `NumberOfDecree` differs from the one the code cites.

## Open risks and unknowns

- **Terms of use.** These are the same IDX Terms of Use as in [idx-sector-classification.md](idx-sector-classification.md): no scraping or crawling, and no commercial use without consent. The owner decides.
- **One-day lag.** A code placed on the board takes effect on a trading day that the API may not yet show. The radar would rank it for that one day. This is low impact, because the book of a call-auction code looks odd but harmless.
- **Rounding of limit prices.** II-A gives percentages, not how JATS rounds a limit to a valid tick. Whether ARA is the highest tick at or below reference × 1.35 is not stated in the text read here.
- **Remarks layout.** The meaning of the positions in `GetStockSummary.Remarks` other than the notation tail is inferred, not documented.
- **Book during call auction.** It is unverified whether Stockbit or Ajaib streams book levels for `X` codes.
- **Ajaib list fields.** Whether Ajaib's `/v1/stock/data/list/` carries a notation is still unchecked.
