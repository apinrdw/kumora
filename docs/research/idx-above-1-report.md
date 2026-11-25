# What IDX's above-1% report holds, and how stable its holder names are

Research for [#471](https://github.com/apinrdw/kumora/issues/471), part of the map [#470](https://github.com/apinrdw/kumora/issues/470). Read on 2026-11-18 (a Wednesday) from a machine in Indonesia. Every claim below comes from parsing files that IDX and KSEI served on that date, unless it cites another source. The scripts were throwaway Python (stdlib only: `zipfile` plus regexes over `xl/sharedStrings.xml` and `xl/worksheets/sheet1.xml`, as in [#395](https://github.com/apinrdw/kumora/blob/research/idx-investor-type-report/docs/research/idx-investor-type-report.md)). Each result says how it was computed so a reader can redo it.

## Answer

- **Four layouts, one set of columns.** The header row moves (row 5, 7, 6, then 5) and the disclaimer grows from 5 to 11 items, but the columns are the same 12 in the same order, with two exceptions. Feb–Mar 2026 have `INVESTOR_TYPE` (KSEI's 9 codes) where Apr–Oct have `INVESTOR_CLASSIFICATION`. Oct 2026 adds a 13th column, `CONTROLLER_OR_AFFILIATE`, between the classification and `LOCAL_FOREIGN`. Find the header by its labels and read columns by name.
- **`PERCENTAGE` is total holding over listed shares, rounded half up to 2 decimals.** `TOTAL_HOLDING_SHARES × 100 / NUMBER_OF_SHARES` (the investor-type report's shares outstanding, which is KSEI's `Sec. Num`) reproduces it for 64,626 of 64,654 rows. Scrip counts in the numerator, and listed shares (scrip included) are the denominator. The 28 misses are hand edits: 15 rows in Apr 2026, BNBR's 12 rows in Jul 2026 (which used Aug's larger share count), and one row in Feb. The value carries 2 decimals. Some months write float noise (`15.370000000000001`), and Apr 2026 has 31 unrounded cells (`36.108405090747539`).
- **`TOTAL_HOLDING_SHARES` = scripless + scrip** for 64,652 of 64,654 rows. The two misses are typos: Feb MAYA and Mar SMRA.
- **The cut-off is ≥1% of listed shares, scrip included.** The smallest exact share in every file is 1.0000000053%, and no row is below 1%. 795–858 rows a month are only above 1% because of their scrip.
- **Classification.** `INVESTOR_CLASSIFICATION` is the classification report's English label without its `(xx)` code. It is in Title Case until Jul 2026 and in sentence case from Aug. It has 35 of the 39 **Investor classifications** and two spelling quirks (`PermanentEstablishment`, and a trailing space on the CV label). It is blank on 208–560 rows a month. From May 2026, every blank is a holder with no scripless shares, which fits the disclaimer: classification covers scripless holdings only.
- **Blank `LOCAL_FOREIGN` (198–244 rows a month) marks a special scrip account.** Nearly all of them have 0 scripless shares, and they also have no domicile. `NATIONALITY` is filled only for individuals. Feb 2026 writes foreign as `A` (Asing) and pads 6,822 codes to 10 characters.
- **(stock, exact investor name) is unique in every month but one:** Apr 2026 lists RALS's PT RAMAYANA MAKMURSENTOSA twice, as a scrip special account and as a scripless account. After normalizing case and punctuation, 2–29 keys a month repeat. These are one holder split across rows, for example BSDE's Paraga Artamida in three rows in Feb.
- **Exact names carry 94.2% of holders from one month to the next.** That is 54,159 of the 57,499 (stock, holder) rows, between 92.6% and 95.2% for each pair of months. Of the 3,340 misses, 2,243 are a holder who is still there under another name. Exact matching shows each of these as one false "exited" plus one false "new", and that happens in 152–272 of about 958 stocks every month.
  - **1,613 differ only in formatting:** whitespace, case, punctuation, `PT`/`Tbk`/`Persero` placement, or word order. A normalized key matches them all.
  - **630 do not match on any key:** 372 rewordings (honorifics, a custodian prefix, a typo), 114 holdings that move unchanged to an unrelated name, and 144 merges or splits.

  The cause is upstream. One investor has several account names, and the report prints one of them, not always the same one. In 210 of the 302 renamed holders that also appear in IDX's daily above-5% report, both names are listed under that one investor there. Names also flip back and forth: 39–83 (stock, name) pairs a month disappear and come back unchanged the month after.
- **Verdict on name matching:** exact names are not enough for "new / exited / up / down". A normalized key (uppercase; strip punctuation, `PT`, `TBK` and `PERSERO`; sort the words) cuts the false pairs from 2,243 to 630, and the stocks affected from 152–272 a month to 32–129. The rest are real aliases that no string rule catches. Removing them would need a holder identity that the report does not publish, such as a SID.
- **Coverage.** There are 955–961 stocks, all equities with 4-letter codes. A stock's rows are contiguous and sorted by code. Each stock has 1–28 rows (median 7). The file leaves out 44–47 of the type report's stocks. In Oct, all but MSKY have price 0 in KSEI's file. The `TRUE` stock is a boolean cell in Feb, Sep and Oct, and the string `TRUE` in Mar–Aug.
- **The ≥5% rows match the daily above-5% report on scripless.** The daily report counts scripless shares only. For the rows whose **scripless** holding is ≥5% of listed shares, the scripless shares equal the daily report's "Saham Gabungan Per Investor" for 99.4–99.8% of rows on all 6 shared dates (Oct: 1,763 of 1,767). 570–606 rows a month have `PERCENTAGE` ≥5 only because of their scrip, and the daily report omits those. The daily report also prints one investor once per name variant: 62–65 extra rows a date.

## The files

The 9 files are the "Pemegang Saham di Atas 1%" entries in the listing from [How IDX serves the Data Kepemilikan Saham listing](idx-kepemilikan-listing.md), fetched from `www.idx.id` with the listed path:

| Period | Path under `https://www.idx.id/Media/` | `DATE` serial | Data rows | Stocks |
|---|---|---|---|---|
| 2026-02-27 | `r2kjzpk5/peng-02-00011-satu-persen.xlsx` | 46080 | 7,257 | 955 |
| 2026-03-31 | `1ivhzj1q/peng-03-00012-satu-persen.xlsx` | 46112 | 7,213 | 955 |
| 2026-04-30 | `pt1hj5vy/peng-04-00013-satu-persen.xlsx` | 46142 | 7,172 | 956 |
| 2026-05-29 | `i3xcp2nk/peng-05-00014-satu-persen.xlsx` | 46171 | 7,161 | 956 |
| 2026-06-30 | `qsplyxa4/peng-06-00015-satu-persen.xlsx` | 46203 | 7,197 | 956 |
| 2026-07-31 | `fjelt0en/peng-2026-07-00018-satu-persen.xlsx` | 46234 | 7,193 | 961 |
| 2026-08-31 | `fahlw1o2/peng-2026-08-00023-satu-persen.xlsx` | 46265 | 7,158 | 961 |
| 2026-09-30 | `yqjhhsee/peng-2026-09-00024-satu-persen.xlsx` | 46295 | 7,154 | 961 |
| 2026-10-30 | `wlef2nvt/peng-2026-10-00029-satu-persen.xlsx` | 46325 | 7,149 | 961 |

Each file has one sheet (`Sheet1` in Feb, Sep and Oct, `Sheet 1` otherwise). `DATE` is a numeric Excel serial, the same on every row, and it equals the listing's period date in all 9 files. The comparisons use the investor-type report for the same 9 dates (`NUMBER_OF_SHARES`), KSEI's `BalanceposEfek<YYYYMMDD>.zip` for the same dates (`Sec. Num`, see [How KSEI serves the Kepemilikan Efek files](ksei-statistik-kepemilikan-listing.md)), and IDX's daily above-5% report for the 6 dates on which both reports exist (29 May to 30 Oct 2026).

## Header layouts

Every disclaimer and label is one string in column `A`, merged across the row, except where noted.

| Files | Indonesian disclaimer | English disclaimer | `[PUBLIC]` tag | Header row | First data row | Sheet `dimension` |
|---|---|---|---|---|---|---|
| Feb | row 1 (`A1:L1`), 5 items | row 3 (`A3:L3`) | none | 5 | 6 | `A1:M7262` |
| Mar | row 2 (`A2:L2`), 8 items | row 4 (`A4:L4`) | `[PUBLIK]` in `F5` | 7 | 8 | `A2:M7231` |
| Apr | row 2, 9 items | row 4 | `[PUBLIK]` in `F5` | 7 | 8 | `A2:O7190` |
| May | row 1, 9 items | row 3 | `[PUBLIC]` in `F4` | 6 | 7 | `A1:L7167` |
| Jun, Jul | row 1, 9 items | row 3 (`A3:K3` or `A3:L3`) | `[PUBLIC]` in `E4` | 6 | 7 | `A1:M7203`, `A1:L7199` |
| Aug, Sep | row 1, 9 items | row 3 | `[PUBLIC]` in `A4` (merged `A4:L4`) | 6 | 7 | `A1:M7164`, `A1:M7160` |
| Oct | row 1 (`A1:N1`), 11 items | row 2 (`A2:N2`) | `[PUBLIC]` in `A3` | 5 | 6 | `A1:N7154` |

May–Sep share one disclaimer text exactly (by MD5). Apr's English text is the same as May's. Its Indonesian text is 2,245 characters long against May's 2,244, with the same 9 items.

Header, Feb–Mar:

`DATE`, `SHARE_CODE`, `ISSUER_NAME`, `INVESTOR_NAME`, `INVESTOR_TYPE`, `LOCAL_FOREIGN`, `NATIONALITY`, `DOMICILE`, `HOLDINGS_SCRIPLESS`, `HOLDINGS_SCRIP`, `TOTAL_HOLDING_SHARES`, `PERCENTAGE` (`A`–`L`)

Apr–Sep: the same, with `INVESTOR_CLASSIFICATION` in `E`. Oct: `INVESTOR_CLASSIFICATION` in `E`, then `CONTROLLER_OR_AFFILIATE` in `F`, and everything after shifts one column right, ending at `PERCENTAGE` in `M`.

### What the disclaimers add

- Feb item 5: "The percentage of Multiple Voting Shares is calculated based on the total number of non-voting share holdings". Mar onward replaces this with item 6: "The percentage calculation for shares with Multiple Voting Rights is based on the number of shares held, not on the voting rights percentage." Feb lists GOTO's multiple-voting shares as rows with `ISSUER_NAME` "MVS GOTO GOJEK TOKOPEDIA Tbk" under code `GOTO`. From Mar they are folded into the GOTO rows.
- Mar onward, item 4: "Ownership calculations are performed based on SID or based on Account numbers for Investors who do not yet hold an SID." Item 3 says eBAE keeps "special scrip accounts for investors who do not yet hold an SID". Item 5 says a holding with no local/foreign is one of those special scrip accounts.
- Apr onward, item 8: "The investor classification data in this report only for scripless shareholding … The determination of investor classification is carried out by each KSEI Account Holder."
- Mar onward, the last item: "In case of data updates for prior reports, adjustments will be applied to the reports of the relevant period." So a past month can be republished.
- Oct, item 10: `CONTROLLER_OR_AFFILIATE` comes from IDX, from each listed company's monthly E009 report (LBRE) for the **preceding** month, and "may not necessarily reflect the most current Controller and/or Affiliate of the Controller status". In Oct the values are `CONTROLLER` (1,194 rows), `AFFILIATE OF THE CONTROLLER` (954), an empty string (4,999) or a missing cell (2).

### Stray cells and rows

| File | What |
|---|---|
| Mar | Rows 7224 and 7226–7231 are present and empty, after the last data row (7220). |
| Apr | Rows 7180–7190 have no data, only an error cell `#DIV/0!` (`t="e"`) in column `O`. One `HOLDINGS_SCRIP` cell is missing (read as 0). |
| Oct | Column `M` is now `PERCENTAGE`, not a stray column. |

A parser that finds the header row by its labels, maps columns by name, and stops at or skips rows with no `SHARE_CODE` handles all of these.

## Values

Method: for each data row, read every column. A missing `<v>` counts as blank. Numbers are read as decimals.

- `HOLDINGS_SCRIPLESS`, `HOLDINGS_SCRIP` and `TOTAL_HOLDING_SHARES` are numeric cells with whole, non-negative values in all 64,654 rows. The one exception is Apr's missing scrip cell.
- **Sum check:** scripless + scrip = total in 64,652 of 64,654 rows. The two misses:
  - Feb, MAYA, MAYAPADA KARUNIA PT: 0 + 6,323,076,332, but total 6,023,326,332. Its `PERCENTAGE` 24.16 is 6,323,076,332 / listed, so the total is the typo.
  - Mar, SMRA, PT SEMAROP AGUNG: 3,814,000,015 + 2,123,804,901, but total 5,909,304,916. Here `PERCENTAGE` agrees with the total, so one of the parts is the typo.
- **Scrip is common.** 1,007–1,047 rows a month have scrip > 0, about 14%.

### What `PERCENTAGE` is a share of

For each row, the share was computed against each candidate denominator and rounded to 2 decimals, then compared with `PERCENTAGE` read as `round(x, 2)`:

| Month | Rows | total / type-report shares, half up | total / KSEI `Sec. Num`, half up | same, half even | same, truncated | scripless / shares | total / KSEI scripless |
|---|---|---|---|---|---|---|---|
| Feb | 7,257 | 7,256 | 7,256 | 7,246 | 3,673 | 6,218 | 3,052 |
| Mar | 7,213 | **7,213** | 7,213 | 7,202 | 3,687 | 6,172 | 3,042 |
| Apr | 7,172 | 7,157 | 7,157 | 7,146 | 3,680 | 6,140 | 3,042 |
| May | 7,161 | **7,161** | 7,161 | 7,151 | 3,675 | 6,124 | 3,028 |
| Jun | 7,197 | **7,197** | 7,187 | 7,187 | 3,725 | 6,170 | 3,093 |
| Jul | 7,193 | 7,181 | 7,181 | 7,171 | 3,691 | 6,159 | 3,132 |
| Aug | 7,158 | **7,158** | 7,158 | 7,148 | 3,660 | 6,136 | 3,117 |
| Sep | 7,154 | **7,154** | 7,154 | 7,144 | 3,677 | 6,139 | 3,114 |
| Oct | 7,149 | **7,149** | 7,149 | 7,138 | 3,661 | 6,148 | 3,156 |

So `PERCENTAGE` = `TOTAL_HOLDING_SHARES` / listed shares × 100, rounded half up to 2 decimals. Listed shares include scrip. The half-even column misses about 10 rows a month, all exact halves. In Jun, KSEI's denominator misses LPPF's 10 rows. That is the month in which IDX's and KSEI's listed shares for LPPF differ (#395), and `PERCENTAGE` follows IDX.

The misses:

- **Apr 2026, 15 rows in 10 stocks** (CITY ×5, MAYA ×2, BBRI, BSDE, CTRA, DPNS, HATM, MSIN, MYOH, TAPG): the value is rounded to 2 decimals but implies a different denominator on each row. For example, CITY's five rows imply 5.40 to 5.88 billion shares, against 5.405 billion listed. BBRI's Danantara row says 49.75 where 79,804,867,107 / 151,559,001,604 is 52.66. These look typed by hand. Apr also has 31 cells carrying the full unrounded quotient (`36.108405090747539` for AKPI). Those round to the right value.
- **Jul 2026, BNBR (12 rows):** every row implies about 263.3 billion shares. That is BNBR's listed count from Aug (263,336,671,587). Jul's type report and KSEI file both have 256,145,404,148. BNBR was mid-way through a share issue (listed shares 173.4 → 256.1 → 263.3 billion, Jun to Aug).
- **Feb 2026, MAYA:** the sum typo above.

So recomputing the share from the row's own total and the type report's listed shares agrees with IDX on 99.96% of rows. When they disagree, IDX's own value is the typed one.

### Decimals

`PERCENTAGE` is always a 2-decimal number. 858 (Feb), 12 (Apr), 883 (Sep) and 878 (Oct) cells are stored as the neighbouring double (`1.1500000000000001`, `4.3499999999999996`). The other months store the shortest form. Apr's 31 unrounded cells are the only cells with real extra digits. Read the value as `round(x, 2)`, or recompute it.

### The 1% edge

For every row, the exact share TOTAL / listed was computed. In all 9 months:

- No row is below 1%. The smallest exact share is 1.0000000053%, the same value every month. 23–32 rows a month print as `1`.
- **795–858 rows a month would be under 1% on scripless alone.** Their scrip lifts them over. The test is on the total.
- The file has no row for a holder under 1%. Whether a holder "fell below 1%" or "sold out" cannot be told from this report.

## Classification and origin

### Values of `INVESTOR_TYPE` (Feb–Mar)

The 9 **KSEI investor type** codes: `CP`, `ID`, `IB`, `MF`, `SC`, `OT`, `IS`, `PF`, `FD`, or blank (244 rows in Feb, 228 in Mar).

### Values of `INVESTOR_CLASSIFICATION` (Apr–Oct)

The **Investor classification** label in English. It is the classification report's header label without the `(xx)` suffix: `Mutual Funds`, not `Mutual Funds (MF)`. Counts per month, Apr to Oct:

| Value | Apr | May | Jun | Jul | Aug | Sep | Oct | KSEI type |
|---|---|---|---|---|---|---|---|---|
| Individual | 2,550 | 2,537 | 2,559 | 2,559 | 2,547 | 2,552 | 2,536 | ID |
| Corporate | 1,986 | 2,268 | 2,303 | 2,317 | 2,286 | 2,296 | 2,320 | CP |
| *(blank)* | 560 | 255 | 234 | 229 | 222 | 219 | 208 | |
| Mutual Funds | 307 | 307 | 310 | 304 | 293 | 281 | 273 | MF |
| Securities Company | 241 | 241 | 241 | 242 | 261 | 267 | 271 | SC |
| Private Bank | 196 | 204 | 212 | 242 | 241 | 241 | 243 | IB |
| Investment Advisors | 196 | 212 | 209 | 219 | 237 | 239 | 238 | OT |
| Private Equity | 234 | 217 | 210 | 207 | 199 | 199 | 197 | CP |
| Insurance | 116 | 116 | 117 | 152 | 150 | 149 | 150 | IS |
| Firm | 155 | 149 | 146 | 143 | 148 | 143 | 138 | CP |
| Bank | 120 | 122 | 125 | 98 | 103 | 106 | 111 | IB |
| State Owned Enterprises | 102 | 104 | 104 | 66 | 79 | 79 | 80 | CP |
| Venture Capital | 51 | 46 | 46 | 52 | 51 | 46 | 45 | CP |
| Investment Manager | 64 | 64 | 64 | 60 | 40 | 39 | 39 | SC |
| Pension Funds | 49 | 48 | 46 | 46 | 45 | 44 | 40 | PF |
| Partnership | 39 | 35 | 38 | 37 | 35 | 35 | 37 | CP |
| Trustee Bank | 34 | 33 | 31 | 31 | 28 | 29 | 30 | IB |
| Sole Proprietorship / Sole proprietorship | 22 | 22 | 22 | 24 | 29 | 27 | 28 | CP |
| Sovereign Wealth Fund | 28 | 28 | 27 | 26 | 26 | 25 | 25 | OT |
| Government | 21 | 21 | 21 | 21 | 21 | 23 | 23 | OT |
| Financial Institutional | 19 | 19 | 19 | 18 | 19 | 18 | 17 | IB |
| Hedge Fund | 12 | 11 | 12 | 12 | 13 | 13 | 13 | MF |
| Permanent establishment | | 14† | 15† | 13† | 13 | 14 | 14 | CP |
| Capital Market Supporting Institutions And/and Professions | 15 | 13 | 11 | 11 | 11 | 8 | 8 | OT |
| Exchange Traded Funds | 16 | 14 | 12 | 12 | 9 | 10 | 10 | MF |
| Commanditaire Vennootschap (CV) Or/or Limited Partnership | | 12 | 12 | 11 | 11 | 10‡ | 10‡ | CP |
| Cooperatives | 12 | 11 | 12 | 11 | 11 | 12 | 12 | IB |
| Investment Fund Selling Agent | 8 | 9 | 10 | 10 | 10 | 10 | 10 | OT |
| Brokerage Firms | 4 | 14 | 15 | 5 | 5 | 5 | 8 | SC |
| Foundation | 6 | 6 | 6 | 6 | 6 | 6 | 6 | FD |
| Peer To Peer Lending / Peer to peer lending | 2 | 2 | 2 | 3 | 3 | 3 | 3 | CP |
| International Organization / organization | 3 | 3 | 2 | 2 | 2 | 2 | 2 | OT |
| State Owned Company | 2 | 2 | 2 | 2 | 2 | 2 | 2 | CP |
| Educational Institution | 1 | 1 | 1 | 1 | 1 | 1 | 1 | FD |
| Association/Social Organizations | | | | 1 | 1 | 1 | 1 | OT |
| Diocese | 1 | 1 | 1 | | | | | OT |

† written `PermanentEstablishment`, with no space. ‡ written with a trailing space.

- 35 of the 39 classifications appear. Central Bank, Conference, Congregation and Political Parties never do.
- The spelling changes in Aug 2026. Multi-word labels go from Title Case to sentence case (`Sole Proprietorship` → `Sole proprietorship`, `Peer To Peer Lending` → `Peer to peer lending`), and `PermanentEstablishment` becomes `Permanent establishment`. Lowercasing, collapsing whitespace and comparing without spaces maps every value onto the `header` strings in `apps/dashboard/src/domain/holdings.ts` (minus their `(xx)` suffix). The KSEI type column above is that file's mapping.
- **Blank classification:** in May–Oct, all 208–255 blank rows have 0 scripless shares: scrip-only holders, unclassified because classification covers scripless only (item 8). Apr is the exception: 560 blanks, of which 34 have scripless shares (for example ABMM's NOBLE INVESTMENT CORPORATION (SPC) LTD., BREN's PT Barito Pacific Tbk). Feb–Mar's blank `INVESTOR_TYPE` rows are the same scrip-only holders (241 of 244 and 227 of 228 have 0 scripless).

### `LOCAL_FOREIGN`, `NATIONALITY`, `DOMICILE`

| Month | `L` | `F` | blank | blank with 0 scripless | `NATIONALITY` blank | Individuals with no nationality | `DOMICILE` blank (of which L / F) |
|---|---|---|---|---|---|---|---|
| Feb | 5,436 | 1,577 (`A`) | 244 | 241 | 4,703 | 12 | 584 (288 / 52) |
| Mar | 5,383 | 1,602 | 228 (`""`) | 227 | 4,656 | 13 | 565 (283 / 54) |
| Apr | 5,352 | 1,607 | 213 | 211 | 4,630 | 13 | 530 (267 / 50) |
| May | 5,333 | 1,594 | 234 | 234 | 4,631 | 8 | 542 (257 / 52) |
| Jun | 5,368 | 1,608 | 221 | 221 | 4,647 | 9 | 534 (260 / 53) |
| Jul | 5,383 | 1,597 | 213 | 213 | 4,643 | 9 | 524 (257 / 54) |
| Aug | 5,346 | 1,600 | 212 | 212 | 4,620 | 9 | 519 (253 / 54) |
| Sep | 5,353 | 1,592 | 209 | 209 | 4,611 | 9 | 502 (238 / 55) |
| Oct | 5,352 | 1,599 | 198 | 198 | 4,622 | 9 | 473 (220 / 55) |

- **Blank `LOCAL_FOREIGN` is a special scrip account** (disclaimer item 5): a holder with no SID whose shares sit in eBAE. Nearly all have 0 scripless shares, and all but one (in May) also have a blank `DOMICILE`. They are 3% of rows, and they include large holders. In Feb, BSDE's PARAGA ARTAMIDA, PT holds 30.52% this way, and AKPI's TIARA INTIMAHKOTA holds 23.03%.
- **Feb 2026 writes foreign as `A`** (Asing) and pads `L` and `A` to 10 characters on 6,822 of 7,013 rows. Mar writes blank as an empty string. Apr–Oct write `L`/`F` and leave a blank cell. Trim, and map `A` to `F`.
- **`NATIONALITY` is filled only for individuals.** No non-individual row has one. 8–13 individuals a month have none.
- **`DOMICILE`** is a country name in capitals (49–50 distinct). It is blank on every special-account row and on 220–288 `L` and 50–55 `F` rows. 42–46 `F` rows a month give `INDONESIA`.
- **Padding elsewhere:** in Feb, Sep and Oct, 23–26 `INVESTOR_NAME`s, 17–19 `ISSUER_NAME`s and 2–3 `NATIONALITY`s have leading or trailing spaces. 53–88 names a month contain a double space. One name in Apr–Jun contains non-breaking spaces (`PT PRATAMA CITRA KARUNIA`).

## Uniqueness within a month

- **(stock, `INVESTOR_NAME`) is unique** in 8 of the 9 files. The exception is Apr 2026, RALS: `PT RAMAYANA MAKMURSENTOSA` appears as a scrip-only special account (no classification, 3,965,000,000 shares, 55.88%) and as a Corporate scripless account (203,513,800, 2.87%).
- **After normalizing** (uppercase; drop punctuation and `PT`/`TBK`/`PERSERO`; sort the words), keys repeat within a stock 29 times in Feb, 12 in Mar, 7 in Apr, and 2–8 a month from May. Each is one holder in two rows:
  - a special scrip account next to the same holder's SID account (Feb AKPI: `TIARA INTIMAHKOTA` 23.03% scrip and `PT. TIARA INTIMAHKOTA` 13.07% scripless);
  - one holder under two SIDs or spellings (Feb BSDE: `PARAGA ARTAMIDA, PT` 30.52%, `PT PARAGA ARTAMIDA` 6.80% and `PT.  PARAGA ARTA MIDA` 2.93%; in Mar these are one row of 40.35%);
  - persistent pairs every month, such as EAST's two `HUSSAIN AHMAD BIN ABDULLAH HARHARAH` spellings and PALM's two `GAVIN ARNOLD CAUDLE` spellings.

  The count falls from 29 to about 5 after Feb–Apr, so KSEI is merging more of these. They still exist. A storage key of (stock, normalized name) would collide. (stock, exact name) collides once in 64,654 rows. A row ordinal within the stock never collides.
- **Within a month, one holder can be spelled differently in different stocks.** 20–56 normalized names a month have more than one raw spelling, on 65–185 rows. Examples: `MAYBANK SECURITIES PTE. LTD.` and `MAYBANK SECURITIES PTE LTD`, or `ZICO TRUST (S) LTD` and `ZICO TRUST (S) LTD.`.
- **Nominee names are not one beneficial owner.** In Oct, 455 rows (92 distinct names) are custodian or omnibus names such as `UOB KAY HIAN PRIVATE LIMITED` (64 stocks), `BANK OF SINGAPORE LIMITED` (34) and `UBS AG SINGAPORE BRANCH` (30). An exact match on such a name says the custodian kept its line, not that one investor stayed.

## Name stability across months

### Method

For each of the 8 consecutive pairs of months, and each stock present in both, every row of month A was matched to a row of month B in this order. A row matched at one step leaves the pool.

1. **exact:** the same `INVESTOR_NAME` string.
2. **formatting:** the same key after uppercasing, turning `.,;:'"()-/&` into spaces, collapsing whitespace, dropping the tokens `PT`, `TBK`, `TB` and `PERSERO`, and sorting the words.
3. **reworded:** the names share at least 60% of their words, once legal forms, honorifics (`DRS`, `DRA`, `IR`, `H`, `SE` …), custodian words (`S/A`, `A/C`, `CLIENTS` …) and account numbers are dropped. Or the two names, with all spaces and punctuation removed, are at least 85% similar (`difflib`). Pairs with equal total shares are tried first.
4. **same shares, unrelated name:** the same `TOTAL_HOLDING_SHARES` to the share, with nothing in common in the names.
5. **merge/split:** an unmatched row whose name is related (as in step 3) to a row that already matched. For example, two A rows become one B row.
6. **exit / new:** whatever is left.

### Results

| Months | A rows | exact | formatting | reworded | same shares, unrelated name | merge/split | exit | new | exact % |
|---|---|---|---|---|---|---|---|---|---|
| Feb → Mar | 7,257 | 6,763 | 277 | 22 | 10 | 30 | 158 | 138 | 93.2% |
| Mar → Apr | 7,213 | 6,795 | 180 | 46 | 14 | 31 | 158 | 122 | 94.2% |
| Apr → May | 7,172 | 6,706 | 208 | 97 | 24 | 19 | 120 | 124 | 93.5% |
| May → Jun | 7,161 | 6,802 | 185 | 29 | 20 | 17 | 119 | 150 | 95.0% |
| Jun → Jul | 7,191 | 6,832 | 186 | 20 | 5 | 13 | 139 | 103 | 95.0% |
| Jul → Aug | 7,193 | 6,851 | 169 | 12 | 9 | 15 | 142 | 112 | 95.2% |
| Aug → Sep | 7,158 | 6,631 | 238 | 113 | 13 | 8 | 161 | 153 | 92.6% |
| Sep → Oct | 7,154 | 6,779 | 170 | 33 | 19 | 11 | 145 | 145 | 94.8% |
| **all 8** | **57,499** | **54,159** | **1,613** | **372** | **114** | **144** | **1,142** | **1,047** | **94.2%** |

"A rows" counts rows of stocks present in both months. Stocks joining or leaving are excluded: 1 joined in Mar → Apr, and in Jun → Jul 1 left and 6 joined.

Stocks with at least one false new/exit pair (a holder still present but not matched):

| Pair starting | Stocks in both | Under exact names | Under the formatting key |
|---|---|---|---|
| Feb | 955 | 242 | 57 |
| Mar | 955 | 215 | 84 |
| Apr | 956 | 272 | 129 |
| May | 956 | 193 | 60 |
| Jun | 955 | 172 | 38 |
| Jul | 961 | 152 | 32 |
| Aug | 961 | 270 | 122 |
| Sep | 961 | 187 | 62 |

### What the misses look like

- **Formatting (1,613):**
  - `PT. Beyond Media` → `PT BEYOND MEDIA`
  - `KAIROS EKSPRES INTERNASIONAL PT` → `PT KAIROS EKSPRES INTERNASIONAL`
  - `TIRTAMAS ANGGADA, PT` → `PT. TIRTAMAS ANGGADA`
  - `PT MINNA PADI INVESTAMA SEKURITAS TBK` → `… Tbk`
  - `SALIM, LIM` → `SALIM LIM`
  - `LO KHENG  HONG. DRS` → `DRS LO KHENG HONG` (13 stocks in Feb → Mar)
  - `CAI LONG` → `LONG CAI`

  The legal-form position (`PT X`, `X PT`, `X, PT`, bare `X`) changes most often: 682 rows in the first per-step pass, against 617 for punctuation and 216 for case.
- **Reworded (372), mostly the same holder:**
  - honorifics added or dropped: `DRS SURONO SUBEKTI` → `SURONO SUBEKTI` (15 stocks in Mar → Apr), `JANG AGUNG HANDOKO` → `IR JANG AGUNG HANDOKO`;
  - a custodian prefix added or dropped: `JPMCB NA RE - SWEDBANK ROBUR …` → `SWEDBANK ROBUR …`, `NIPPON STEEL CORPORATION` → `NOMURA SINGAPORE LIMITED S/A NIPPON STEEL CORPORATION`;
  - long and short legal names: `PERUSAHAAN PERSEROAN (PERSERO) PT DANANTARA ASSET MANAGEMENT` → `PT DANANTARA ASSET MANAGEMENT (PERSERO)` (9 stocks), `UOB KAY HIAN PRIVATE LIMITED` → `UOB KAY HIAN PTE LTD` (dozens of stocks in Apr → May);
  - typos: `SINTAWATI` → `SINTAWATY`, `MATAHARI DEPARTMENT` → `DEPATMENT`, `UBS AG HONG KONG` → `HONGKONG`.

  The similarity rule also pairs a few different entities, such as `CGS INTERNATIONAL SECURITIES SINGAPORE` → `… MAURITIUS`. So this count is an estimate.
- **Same shares, unrelated name (114).** This group mixes two cases:
  - Aliases of one investor that flip month to month:
    - AMAG, CFIN, PNBS, VRNA, PANS: `BANK PAN INDONESIA TBK, PT` ↔ `Panin Bank Tbk, PT`, flipping in Mar, Apr, Aug and Sep.
    - NETV: `PT MD PICTURES TBK` ↔ `PT MD ENTERTAINMENT TBK`, 4 flips.
    - CARE: `PT METRO HEALTHCARE INTERNATIONAL` ↔ `ANUGRAH KASIH RAJAWALI, PT`, 3 flips.
    - TCID: `MANDOM CORPORATION` ↔ `KALON MIDCO HOLDINGS CO LTD`, back and forth.
    - DCII: `OTTO TOTO SUGIRI` ↔ `ERVIN WIJAYA`, back and forth.
    - MTEL: `PT TELEKOMUNIKASI INDONESIA` → `TELKOM INDONESIA (PERSERO) TBK`.
  - Whole blocks that moved to a new holder (`PT BASIS UTAMA PRIMA` → `PT TIRTA ORISA YASA` in 5 stocks, `PT MEGA INTI PERDANA UTAMA` → `PT ORION GLOBAL DEVELOPMENT`).

  The name alone cannot tell these apart.
- **Merge/split (144), mostly Feb–Apr.** Feb's split rows (special scrip account, second SID) are merged in Mar. AKPI's `PRISMATAMA NUGRAHA` (21.24%, scrip) and `PT PRISMATAMA NUGRAHA` (6.04%) become one row of 27.28%. BSDE's three Paraga rows become one row of 40.35%.
- **Exit (1,142) and new (1,047), split by `PERCENTAGE`:**

  | Band | Exits | News |
  |---|---|---|
  | 1.00–1.49% | 636 | 641 |
  | 1.50–4.99% | 431 | 316 |
  | ≥5% | 75 | 90 |

  More than half sit at the 1% edge. This step cannot tell a sale from a rename with a changed holding, so some exits ≥1.5% are renames. `WIRASTUTI PUNTARAKSMA, S.H.` 11.43% → `BERNADETTE WIRASTUTI PUNTARAKSMA` 11.65% was caught as reworded. Others with a changed holding and no shared words were not.

### Why names change: one investor, several account names

The daily above-5% report prints, for each investor (by SID), every sub-account's "Nama Rekening Efek" and the holder name. On the 6 dates that have both reports, every A → B name change where the two rows carry equal total or scripless shares was looked up there. Of the 302 changes whose investor appears in the daily report, **210 have both names already listed under that one investor**, for example:

- `PERUSAHAAN PERSEROAN (PERSERO) PT. ASABRI` / `… PT ASABRI` (ARMY, BTEK, FIRE, POOL, PPRO, SMRU …)
- `AJB BUMIPUTERA 1912` / `AJB BUMI PUTERA 1912`
- `PT. MULTIPOLAR TBK` / `MULTIPOLAR,PT,TBK`
- `PT. MANUNGGAL PRIME DEVELOPMENT` / `MANUNGGAL PRIME DEVELOPMENT, PT`

So the above-1% report prints one of an investor's account names, and which one it prints is not stable. A name that disappears and comes back unchanged a month later shows the same flipping. In all, 39–83 (stock, exact name) pairs a month are present in month *i*, absent in *i*+1 and back in *i*+2, on stocks present in all three. Normalization merges most of these spellings. The rest need an alias table or a SID, and the report publishes no SID.

### What this means for "new / exited / up / down"

- **Exact name:** 94.2% of rows match. A false exited + new pair appears in 152–272 stocks a month, out of about 958.
- **Formatting key:** 97.0% of rows match (54,159 + 1,613 of 57,499). False pairs remain in 32–129 stocks a month: 630 rows over 8 months, about 79 a month. They come from aliases, rewording and merges.
- **Up / down** on a matched holder is reliable: when names match, totals are whole numbers from the same source. Feb–Apr carry a few typed values (above).
- **Exited** cannot mean "sold". It means "no longer at ≥1% under a name we recognise". More than half of real exits and entries sit at 1.00–1.49%.

## Stocks and rows

| Month | Stocks | Type-report stocks with no row | Rows per stock (min / median / max) |
|---|---|---|---|
| Feb | 955 | 47 | 1 / 7 / 28 (CARS) |
| Mar | 955 | 47 | 1 / 7 / 28 (INPC) |
| Apr–Jun | 956 | 46 | 1 / 7 / 28 (INPC) |
| Jul–Aug | 961 | 46 | 1 / 7 / 28 (INPC) |
| Sep–Oct | 961 | 44 | 1 / 7 / 28 (INPC) |

- **Every code is a 4-letter equity** that is in the type report and has type `EQUITY` in KSEI's file. There are no warrants, rights or bonds. The 5-letter share classes (`EDJSA`, `EDJSB`, `MAMIP`, `MYRXP`) never appear.
- **The left-out stocks are unpriced.** In Oct, 43 of the 44 have `Price` 0 in KSEI's `BalanceposEfek`. The exception is MSKY (price 32), which is also missing from the daily above-5% report (#395).
- **Order:** rows are grouped by stock, and the stocks are sorted by code. Within a stock, rows are in descending `PERCENTAGE` in Feb–Mar (926–940 of 955 stocks) and in no fixed order from Apr (44–104 stocks descending). Sort on read.
- **`ISSUER_NAME`** is constant per code, apart from two cases: Feb GOTO (the `MVS` rows above) and Sep MLPL, where one row says `MULIA INDUSTRINDO Tbk` instead of `MULTIPOLAR Tbk`. Take the issuer name from elsewhere.
- **No stock's rows sum past 100%.**
- **`TRUE`:** in Feb, Sep and Oct the code is a boolean cell (`t="b"`, value `1`) on all of its 4–6 rows. In Mar–Aug it is the string `TRUE`. Map a boolean `1` in `SHARE_CODE` to `TRUE`, as for the type report (#395).

## Against the daily above-5% report

Files: the "Pemegang Saham di Atas 5%" entries for 29 May, 30 Jun, 31 Jul, 31 Aug, 30 Sep and 30 Oct 2026, for example `https://www.idx.id/Media/t4qnuz2a/peng-2026-10-30-00107-lima-persen.xlsx`. In each, a row with a number in `No` starts an investor. The investor's "Saham Gabungan Per Investor" and percentage for the report date are in columns `P` and `Q`.

**The daily report counts scripless shares only.** For example, DNAR's OK NEXT CO.LTD holds 4,923,693,929 scripless and 10,364,979,314 scrip. The 1% report gives 90.51% (the total), and the daily report gives 4,923,693,929 shares, 29.15%. TOWR's PT DWIMURIA INVESTAMA ANDALAN shows 19.95% in the 1% report and 7.45% in the daily report. So the comparison selects 1% rows whose **scripless** holding is ≥5% of listed shares, the rule #395 found for the type report's `>=5%` band. Rows are matched on (stock, scripless shares = "Saham Gabungan") as a multiset:

| Date | 1% rows, scripless ≥5% | Daily-report investors on those stocks | Matched | 1% only | Daily only: repeated investor | Daily only: other | Daily investors on stocks absent from the 1% report | 1% rows with `PERCENTAGE` ≥5 only by scrip |
|---|---|---|---|---|---|---|---|---|
| 29 May | 1,698 | 1,767 | 1,688 | 10 | 64 | 15 | 101 | 606 |
| 30 Jun | 1,713 | 1,782 | 1,703 | 10 | 64 | 15 | 101 | 591 |
| 31 Jul | 1,737 | 1,807 | 1,729 | 8 | 65 | 13 | 101 | 584 |
| 31 Aug | 1,750 | 1,817 | 1,744 | 6 | 65 | 8 | 100 | 579 |
| 30 Sep | 1,749 | 1,814 | 1,745 | 4 | 65 | 4 | 98 | 575 |
| 30 Oct | 1,767 | 1,829 | 1,763 | 4 | 62 | 4 | 98 | 570 |

- **Matched rows mostly agree on the name too.** On 30 Oct, of 1,763 matched rows, 1,738 have the 1% name equal to the daily report's holder name, 9 equal one of its account names, 16 differ in formatting, and none differ otherwise.
- **The 1%-only / daily-only pairs are the same investors with a different scripless total.** In Sep–Oct: SQMI Wilton Resources (1% 8,312,954,942 vs daily 7,692,954,942), MYOH ST International, PICO Citrajaya Perkasamulia and WINS Wintermarjaya Lestari. In May–Aug also TAPG, SRAJ, BVIC, LPPF, PEHA, KLBF and BPII. These are #395's misses: the 1% report sums an investor's accounts across types, and the daily report seems to group by investor and type.
- **"Repeated investor" means the daily report lists one investor once per name variant**, each with the same "Saham Gabungan". ASRI's investor appears 3 times (`MANUNGGAL PRIME DEVELOPMENT, PT`, `…,PT`, `PT. MANUNGGAL …`), and POSA's 4 times. Counting investors in the daily report overcounts by 62–65.
- **Stocks in the daily report but not in the 1% report** are the unpriced stocks, the 5-letter share classes, and SQBB and SQBI until they left in Sep (Taisho holds 78.63% of SQBI). 98–101 daily-report investors sit on these stocks.

So the ≥5% rows of the 1% report and the daily report agree, once both are read on scripless shares. The 1% report's `PERCENTAGE` ≥5 is a different and larger set, because it includes scrip.

## Open points

- **Republishing:** the disclaimer says prior reports can be adjusted. No republished 1% file was seen. The Wayback capture of the Sep file from 2026-11-06 still matches ([listing research](idx-kepemilikan-listing.md)).
- **What the daily report's grouping is:** "per investor and type" is inferred from 4–10 stocks a date, as in #395. It is not documented.
- **A holder's identity:** neither report publishes a SID. Any matching beyond a normalized name needs a curated alias list, or acceptance of some false new/exited pairs.
