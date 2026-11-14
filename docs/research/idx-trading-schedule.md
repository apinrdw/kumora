# Where the IDX trading schedule and holiday list come from

Research for [#56](https://github.com/apinrdw/kumora/issues/56), part of the Market Live map [#38](https://github.com/apinrdw/kumora/issues/38). Read on 2026-11-06.

## Answer

- **Schedule:** IDX Rule II-A sets the session times. The current text is Kep-00158/BEI/10-2026, issued and in force on 20 October 2026. The times have no seasonal variants: no Ramadan hours and no half days. Only Friday differs, with a longer break.
- **Holidays:** IDX publishes one calendar per year. It comes as a signed PDF announcement, plus a JPG of the same table on the "Jadwal Libur Bursa" page. There is no machine-readable feed. The 2026 and 2027 calendars are both out.
- **Recommendation: bake both in.** Put the session table and each year's holiday dates in code that the extension and the dashboard Worker share. Ajaib's `trading-day/detail` can be a passive cross-check that logs a mismatch. It should not be the source.

## Session times (Regular Market, WIB = UTC+7, no DST)

Source: Rule II-A, sections IV.2.1 (Monday–Thursday) and IV.2.2 (Friday), in [Kep-00158/BEI/10-2026](https://www.idx.co.id/Media/stumk2gi/signed_peraturan_nomor_ii_a_tentang_perdagangan_efek_bersifat_ekuitas-261020.pdf). The decree was issued and took effect on 20 October 2026. It replaced Kep-00157/BEI/10-2026 of 19 October 2026. The reasons both decrees give concern Auto Rejection limits, not session times. IDX's [trading hours page](https://www.idx.id/id/produk-layanan/jam-dan-mekanisme-perdagangan/) shows the same table and cites the same decree.

| Phase | Mon–Thu | Fri | Ajaib `trading-day/detail` phase |
|---|---|---|---|
| Pre-opening, order input | 08:45:00–08:57:59 | same | `PRE_OPENING` / INPUT |
| Pre-opening, no withdraw | 08:56:00–08:57:59 | same | `PRE_OPENING` / NON_CANCELLATION |
| Pre-opening, no amend | 08:56:00–08:59:59 | same | (same) |
| Pre-opening, matching at the opening price | 08:58:00–08:59:59 | same | `PRE_OPENING` / MATCHING |
| Session I (continuous auction) | 09:00:00–12:00:00 | 09:00:00–11:30:00 | `MARKET_PHASE` |
| Break | 12:00:00–13:30:00 | 11:30:00–14:00:00 | `MARKET_BREAK` |
| Session II (continuous auction) | 13:30:00–15:49:59 | 14:00:00–15:49:59 | `MARKET_PHASE` |
| Pre-closing, order input | 15:50:00–15:59:59 | same | `PRE_CLOSING` |
| Random closing (price set at a random moment) | 15:58:00–15:59:59 | same | `PRE_CLOSING` / RANDOM_CLOSING |
| Pre-closing, no withdraw | 15:56:00–15:59:59 | same | (same) |
| Pre-closing, no amend | 15:56:00–16:01:59 | same | (same) |
| Pre-closing, matching at the closing price | 16:00:00–16:01:59 | same | (same) |
| Post-closing (trades at the closing price only) | 16:02:00–16:15:00 | same | `POST_TRADING` |

The phase mapping in the last column is inferred from the names in the [#48 DevTools run](https://github.com/apinrdw/kumora/issues/48). It was not checked bound by bound.

Other markets and boards, for completeness:

- **Cash Market:** session I only. Mon–Thu 09:00–12:00, Fri 09:00–11:30 (IV.3).
- **Negotiated Market:** Mon–Thu 09:00–12:00 and 13:30–16:30, Fri 09:00–11:30 and 14:00–16:30 (IV.4). Its trades can print after the Regular Market closes.
- **Papan Pemantauan Khusus** (the full-call-auction watch board) runs hourly call auctions under Rule II-X, so its trades come in bursts, not continuously. Kep-00140/BEI/09-2026 amended II-X. The hours page shows the table: for example, Mon–Thu session 1 collects orders 09:00–09:55 and matches at a random moment in 09:55:01–09:59:59.

The non-cancellation periods started in 2025, as the hours page notes.

**Trading days:** Rule II-A I.16 defines a Hari Bursa as Monday to Friday, except national holidays and days IDX declares exchange holidays.

**Unplanned halts:** Rule II-A X.1 lets IDX halt all trading for technical faults, a sharp IHSG fall, disasters or unrest. A halt longer than one session needs OJK approval (X.2–X.3). No calendar can predict a halt.

## Holiday list

**Form.** One PDF announcement per year, signed by two IDX directors, with the calendar as an attachment. For 2026 this is [Peng-00171/BEI.POP/09-2025](https://www.idx.co.id/StaticData/NewsAndAnnouncement/ANNOUNCEMENTSTOCK/Exchange/Peng-00171%20Libur%20Bursa%202026-No.%20Peng-00171BEI.POP09-2025.pdf), dated 23 September 2025. It derives the list from the government's joint ministerial decree on national holidays and cuti bersama (collective leave days). IDX's "Jadwal Libur Bursa" page ([id](https://www.idx.id/id/berita/jadwal-libur-bursa), [en](https://www.idx.id/en/news/trading-holiday)) shows the same table as one JPG per year. The page loads those images from `primary/AboutUs/GetTradingHolidays?lang=id|en`. That JSON returns only `{title, imageUrl}` per year, for 2020 through 2027, so the dates themselves are not machine-readable anywhere.

**Changes.** Each calendar notes that IDX can add a holiday later, either if Bank Indonesia closes clearing that day or if the government changes national holidays or collective leave. A change comes as a new announcement. The image file names show past revisions (`2025_ind-rev`, `2024_ind-v3`).

**Timing.** The 2026 calendar came out on 23 September 2025. The 2027 calendar is already published, based on joint decree 1205/2026, 3/2026 and 2/2026. So each year's list arrives about three months ahead.

**2026** (239 trading days): 1 Jan; 16 Jan; 16–17 Feb; 18, 19, 20, 23, 24 Mar; 3 Apr; 1, 14, 15, 27, 28 May; 1 Jun; 16 Jun; 17 Aug; 25 Aug; 24, 25, 31 Dec.

**2027** (241 trading days, from the [English calendar image](https://www.idx.co.id/media/ruodkzvq/2027_eng2_page-0001.jpg)): 1 Jan; 5 Jan; 5 Feb; 8, 9, 10, 11, 12, 15, 25, 26 Mar; 6, 17, 18, 19, 20 May; 1 Jun; 17 Aug; 24, 31 Dec.

31 December is an exchange-only holiday ("Libur Bursa") every year, so a government holiday list alone is not enough.

**Access note.** `idx.co.id` sits behind Cloudflare and returns 403 to curl and to web fetch tools. `www.idx.id` serves the same pages, the same JSON API and the same `/Media/...` and `/StaticData/...` files without a challenge. A maintainer who updates the table can read the yearly PDF there.

## Runtime or baked in

**Recommendation: bake in.** Keep the session table and each year's holiday dates in one shared module that the extension and the dashboard's Durable Object both import. The Friday break and the 2027 list are the only data that need care.

Why not read Ajaib's `v1/stock/data/trading-day/detail` at runtime:

- **It needs the Ajaib tab, signed in.** Per #48, a REST call with only the JWT gets 403. The extension has to watch the page's own request or copy its headers. The gate that decides whether to stream would then depend on the tab it is gating.
- **It only covers today.** It answers "what are today's phases", not "is next Monday a trading day". The dashboard also needs past trading days to name each day's Durable Object and to show "market closed".
- **Its holiday behaviour is unknown.** The #48 run saw it on a trading day only. Nobody has checked what it returns on a weekend or a holiday.
- **The official data is small and slow-changing.** The session times have one rule source and no variants. Holidays change once a year, three months ahead, plus rare ad-hoc additions.

Use the Ajaib response as a cross-check. The content script already sees the page's requests, so it can compare `trading-day/detail` with the baked table and log any difference. A difference means the table needs an update, or that IDX announced something ad hoc.

**Upkeep:** once a year, after IDX publishes the next calendar (around September), add that year's dates from the PDF announcement. Also add any mid-year announcement. If the table has no entry for the current year, the code should fail loudly, not assume every weekday is a trading day.

**Gate shape:** stream from 08:45:00 to 16:15:00 WIB on a trading day, the full span of Regular Market phases, and keep relaying through the break. During the break the tape is quiet, but the socket stays up and Stockbit `iepiev` frames come only in auctions. A wider window costs little. A narrower one loses pre-opening and closing-auction data.

## Sources

- IDX, Kep-00158/BEI/10-2026, Rule II-A Perdagangan Efek Bersifat Ekuitas, issued and in force on 20 October 2026: https://www.idx.co.id/Media/stumk2gi/signed_peraturan_nomor_ii_a_tentang_perdagangan_efek_bersifat_ekuitas-261020.pdf (also at `www.idx.id/Media/...`)
- IDX trading-rules index (JSON), the source of the current II-A entry: https://www.idx.id/primary/Regulation/GetTradingRegulations?lang=id
- IDX, Jam dan Mekanisme Perdagangan: https://www.idx.id/id/produk-layanan/jam-dan-mekanisme-perdagangan/ (mirror of https://www.idx.co.id/id/produk/mekanisme-dan-jam-perdagangan)
- IDX, Peng-00171/BEI.POP/09-2025, Kalender Libur Bursa Tahun 2026, 23 September 2025: https://www.idx.co.id/StaticData/NewsAndAnnouncement/ANNOUNCEMENTSTOCK/Exchange/Peng-00171%20Libur%20Bursa%202026-No.%20Peng-00171BEI.POP09-2025.pdf
- IDX, Jadwal Libur Bursa page and its API: https://www.idx.id/id/berita/jadwal-libur-bursa, https://www.idx.id/primary/AboutUs/GetTradingHolidays?lang=en
- IDX, Trading Holiday Calendar 2026 and 2027 (images): https://www.idx.co.id/media/p5dbdjtk/2026_eng_page-0001.jpg, https://www.idx.co.id/media/ruodkzvq/2027_eng2_page-0001.jpg
- Ajaib `trading-day/detail` observation: [#48](https://github.com/apinrdw/kumora/issues/48) comments, 2026-11-06.
