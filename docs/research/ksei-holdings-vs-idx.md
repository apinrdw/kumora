# KSEI's Kepemilikan Efek file compared with IDX's investor type and classification reports

Research for [#357](https://github.com/apinrdw/kumora/issues/357), part of the map [#350](https://github.com/apinrdw/kumora/issues/350). Read on 2026-11-15 (a Sunday) from a machine in Indonesia. Every claim below comes from a live request to KSEI or IDX on that date, or from parsing the files those requests returned, unless it cites another source. The parsing scripts were throwaway Python (stdlib only); their method is described with each result so a reader can redo it.

## Answer

- **The file:** `BalanceposEfek<YYYYMMDD>.zip` holds one pipe-delimited `Balancepos<YYYYMMDD>.txt`, one row per security, 25 columns: `Date|Code|Type|Sec. Num|Price`, then `Local IS|CP|PF|IB|ID|MF|SC|FD|OT|Total`, then the same nine and `Total` for `Foreign`. For an `EQUITY` row, `Sec. Num` is listed shares, `Price` is the month-end close in rupiah, and every holding is a count of **scripless shares**. On every equity row of every file read, the nine types sum exactly to each `Total`. There is no <5% / >=5% split and no issuer name.
- **Picking stocks:** keep `Type == "EQUITY"` **and** `Price > 0`. That gives exactly the classification report's stock list (962 codes in Sep and Oct 2026). `Type == "EQUITY"` alone gives exactly the IDX **type** report's list (1,005–1,007 codes), which adds 43–44 unpriced equities (delisted or long-suspended, such as BORN, CPGT, MYRX). Codes are 4 letters, plus a few 5-letter class or preferred shares (`MAMIP`, `MYRXP`, `EDJSA`, `EDJSB`), all unpriced today.
- **Totals agree exactly.** Per stock, KSEI's `Sec. Num` equals IDX's `NUMBER_OF_SHARES`, and KSEI's local + foreign total equals the type report's `TOTAL SCRIPLESS` and the classification report's `Total Scripless`, for 100% of stocks in Aug, Sep and Oct 2026.
- **The nine types agree once local and foreign are added together.** KSEI's local + foreign value per type equals the type report's domestic + foreign value (each summed over <5% and >=5%) for all nine types in 993–995 of 1,005–1,007 stocks (98.8%) every month, and within 1% of scripless in all but 2 (TRIL 4.0%, SRSN 2.2%). The same 12 stocks differ, by the same amounts, in all three months.
- **The local/foreign split does not agree.** IDX's two reports share one local/foreign split; KSEI's file uses another. The difference is almost all in **Individual (ID)**: KSEI counts shares as local that IDX counts as foreign, by the same amount on both sides. Per stock:

  | Month    | KSEI local total = IDX type local | within 1% of scripless | all 18 type × origin values exact | KSEI local total = classification `Local_` sum | within 1%   |
  | -------- | --------------------------------- | ---------------------- | --------------------------------- | ---------------------------------------------- | ----------- |
  | Aug 2026 | 118 / 1,007 (11.7%)               | 938 (93.1%)            | 117 (11.6%)                       | n/a (unsplit layout)                           | n/a         |
  | Sep 2026 | 109 / 1,005 (10.8%)               | 936 (93.1%)            | 108 (10.7%)                       | 92 / 962 (9.6%)                                | 893 (92.8%) |
  | Oct 2026 | 105 / 1,005 (10.4%)               | 936 (93.1%)            | 104 (10.3%)                       | 88 / 962 (9.1%)                                | 893 (92.8%) |

  The 16 non-ID type × origin values match exactly for 98.3–98.4% of stocks. Market-wide the gap is small (Oct 2026 foreign share of scripless: KSEI 30.47%, IDX 30.59%), but for a few stocks it is the whole picture: ACRO is 3.1% foreign in KSEI's file and 89.8% in IDX's; BSBK 0.9% vs 47.0%. In Oct 2026, 69 of 962 stocks differ by more than 1 point of foreign share, 21 by more than 5, 10 by more than 10.

- **The 39 classifications do not roll up to the 9 types.** Individual is the only class that equals its type in every stock. The best single-type mapping of the other classes that a greedy search found reproduces all nine type values exactly for only 32% of stocks, and within 1% for 68%. The owner's ~70% for CP and OT is a property of the data, not a mapping mistake: one class (Bank, for example) lands in different types for different accounts.
- **History:** the same 25-column header, byte for byte, in every file read from Jan 2008 to Oct 2026 (2008, 2009, 2012, 2015, 2017, 2020, 2023 and Aug–Oct 2026 samples). The one change: the Jan 2008 file writes `Type` as a number (`1` for equities) where Mar 2009 onward writes `EQUITY`. All 226 month-ends from Jan 2008 to Oct 2026 are on the legacy host `web.ksei.co.id/Download/`, with their original upload time. `www.ksei.co.id/storage/Download/` has Jan 2009–Apr 2013 and Jan 2018–Oct 2026, and nothing for May 2013–Dec 2017 (56 months). So about 18 years are usable, 13 of them from `www` alone.
- **Files get corrected.** The Dec 2020 file on `www.ksei.co.id` is a corrected copy (zip entry dated 2021-10-19) of the one on `web.ksei.co.id` (dated 2021-01-01): three rows' `Sec. Num` changed (MSIN 520,200,000,000 → 5,202,000,000, and two bonds). Holdings were unchanged.
- **Publish lag:** KSEI uploads the file at about 07:07 WIB on the first weekday after the period end (`Last-Modified`: Sep data 1 Oct 07:07, Oct data 2 Nov 07:08). IDX's type and classification reports for the same months appeared 2 Oct 13:53 and 2 Nov 14:53 WIB. KSEI is 7 hours to 1.3 days earlier.
- **Recommendation:** take the chart from KSEI's file. It goes back to Jan 2008 (through two hosts) in one layout, its nine type values are IDX's to within 1% for 99.8% of stocks, it arrives first, and parsing it is a `split("|")`. Label its split as KSEI's, and expect it to differ from the Shareholders composition panel on local vs foreign for about 7% of stocks by more than a point (see [Where the chart and the panel can disagree](#where-the-chart-and-the-panel-can-disagree)). If the chart must agree with the panel on local/foreign, the IDX type report is the only source that does, and it starts in Nov 2025.

## The file

### Columns and units

```
Date|Code|Type|Sec. Num|Price|Local IS|Local CP|Local PF|Local IB|Local ID|Local MF|Local SC|Local FD|Local OT|Total|Foreign IS|Foreign CP|Foreign PF|Foreign IB|Foreign ID|Foreign MF|Foreign SC|Foreign FD|Foreign OT|Total
30-OCT-2026|BBCA|EQUITY|123275050000|4980|2310613490|752250260|302459300|517672400|12030567470|1072720030|119977978|72753960|15254200|17194269088|666444425|575351467|4718402998|2382605437|324800480|20393323810|457281188|320342605|5420869622|35259422032
```

- `Date` is the period end as `DD-MON-YYYY`, the same on every row. Lines end in CRLF. The two `Total` columns share a name; read by position.
- `Sec. Num`: listed shares for `EQUITY` (BBCA 123,275,050,000, the type report's `NUMBER_OF_SHARES`); nominal amount for bonds (`FR0042` 14,019,751,000,000 with `Price` 1); units for funds.
- `Price`: the month-end close for an equity (BBCA 4,980), 0 for an equity with no price, 1 for most debt.
- Holdings: scripless shares for equities. BBCA's local total 17,194,269,088 plus foreign 35,259,422,032 is 52,453,691,120, the scripless figure IDX prints.
- The nine types have no legend in the file. They are the nine of IDX's type report: IS insurance, CP corporate, PF pension fund, IB financial institution, ID individual, MF mutual fund, SC securities company, FD foundation, OT others (legend row of `peng-2026-10-00027-tipe.xlsx`).
- Non-equity quirks, irrelevant once filtered: debt crowdfunding, sukuk crowdfunding, SRBI and perpetual-bond rows have an empty `Sec. Num` (215–219 rows in 2026), and 2020 mutual fund rows carry fractional units (`52541809.7586`).

### Securities in one file (Oct 2026, 3,733 rows)

| `Type`                                                                                                                                                                                                                               | Rows      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| EQUITY                                                                                                                                                                                                                               | 1,005     |
| CORPORATE BOND                                                                                                                                                                                                                       | 935       |
| STRUCTURED WARRANT                                                                                                                                                                                                                   | 533       |
| SUKUK                                                                                                                                                                                                                                | 367       |
| EQUITY CROWDFUNDING (ECF)                                                                                                                                                                                                            | 278       |
| SUKUK CROWD FUNDING                                                                                                                                                                                                                  | 175       |
| TERM NOTES                                                                                                                                                                                                                           | 169       |
| GOVERNMENT BOND                                                                                                                                                                                                                      | 73        |
| SBSN, MUTUAL FUND, DEBT CROWD FUNDING, NEGOTIABLE CERTIFICATE OF DEPOSIT, BANK INDONESIA RUPIAH SECURITIES (SRBI), WARRANT, SPN, EBA, PERPETUAL BONDS, DANA INVESTASI REAL ESTATE, RIGHT, ELECTRONIC GOLD RECEIPTS, COMMERCIAL PAPER | 1–54 each |

Warrants (`BRNA-W`), rights (`BUVA-R`), ETFs (`R-LQ45X`, typed `MUTUAL FUND`) and crowdfunding equity (`ABNSECF`) all have their own `Type`, so `EQUITY` is only shares. Each code appears once per file.

### Which equities to keep

| Month    | `EQUITY` rows | of which `Price > 0` | Type report stocks | Classification report stocks |
| -------- | ------------- | -------------------- | ------------------ | ---------------------------- |
| Aug 2026 | 1,007         | 963                  | 1,007 (same codes) | 962 (priced set minus SQBI)  |
| Sep 2026 | 1,005         | 962                  | 1,005 (same codes) | 962 (same codes as priced)   |
| Oct 2026 | 1,005         | 962                  | 1,005 (same codes) | 962 (same codes as priced)   |

All 43 unpriced Oct 2026 equities still hold scripless shares (none is zero). Against KSEI's `StatisEfek20261030.txt`, 24 of them are absent from the securities master entirely (APOL, BORN, CKRA, CPGT, KARK, TRUB…) and the rest are listed as `ACTIVE` there (ATPK, MYRX, NIPS, SUDI…), which fits delisted and long-suspended stocks. SQBI is priced in Aug 2026 and absent from KSEI's file from Sep, but already missing from IDX's Aug classification report.

## Per-stock comparison with IDX's reports

Method: parse the KSEI `.txt` and IDX's xlsx files (`xl/sharedStrings.xml` + `xl/worksheets/sheet1.xml`), join on stock code, and compare integers. For the type report, a type's value is its `<5%` plus `>=5%` columns. "Within 1%" means the absolute difference is at most 1% of the stock's scripless total. Files:

- KSEI: `https://www.ksei.co.id/storage/Download/BalanceposEfek20260831.zip`, `...20260930.zip`, `...20261030.zip`.
- IDX type: `https://www.idx.id/Media/wkjfudt3/peng-2026-08-00022-tipe.xlsx`, `.../2ygosvbp/peng-2026-09-00025-tipe.xlsx`, `.../jv2jkbtd/peng-2026-10-00027-tipe.xlsx`.
- IDX classification: `https://www.idx.id/Media/y0vjakdz/peng-2026-08-00021-klasifikasi.xlsx`, `.../yyhm1ha5/peng-2026-09-00026-klasifikasi.xlsx`, `.../5dxpntd5/peng-2026-10-00028-klasifikasi.xlsx`.

### Against the type report (all 1,005–1,007 stocks)

| Check                                     | Aug 2026      | Sep 2026      | Oct 2026      |
| ----------------------------------------- | ------------- | ------------- | ------------- |
| `Sec. Num` = `NUMBER_OF_SHARES`           | 100%          | 100%          | 100%          |
| local + foreign total = `TOTAL SCRIPLESS` | 100%          | 100%          | 100%          |
| 9 types, local + foreign, exact           | 995 (98.8%)   | 993 (98.8%)   | 993 (98.8%)   |
| 9 types, local + foreign, within 1%       | 1,005 (99.8%) | 1,003 (99.8%) | 1,003 (99.8%) |
| local total exact / within 1%             | 11.7% / 93.1% | 10.8% / 93.1% | 10.4% / 93.1% |
| foreign total exact / within 1%           | 11.7% / 93.1% | 10.8% / 93.1% | 10.4% / 93.1% |
| all 18 values exact / within 1%           | 11.6% / 92.9% | 10.7% / 92.9% | 10.3% / 92.9% |
| 16 non-ID values exact                    | 98.4%         | 98.4%         | 98.3%         |

Per type and origin, exact match in Oct 2026: IS, PF, FD, SC (foreign) and IB (local) 100%; CP, MF, OT, SC (local), IB (foreign) 99.2–99.9%; **ID 10.4%** (local and foreign alike).

**The Individual shift.** For 1,000 of 1,005 stocks in Oct 2026, KSEI's local ID minus IDX's local ID equals IDX's foreign ID minus KSEI's foreign ID: the same shares sit on the other side. KSEI has the larger local figure in 848 stocks (84%). Summed over all stocks the moved shares are 29.8 billion of 10.54 trillion scripless (0.28%), but some stocks are dominated by it:

| Stock (Oct 2026) | KSEI local ID  | IDX local ID   | Foreign share, KSEI | Foreign share, IDX |
| ---------------- | -------------- | -------------- | ------------------- | ------------------ |
| ACRO             | 3,361,481,534  | 352,315,185    | 3.11%               | 89.84%             |
| BSBK             | 2,323,759,730  | 2,315,966,230  | 0.86%               | 47.00%             |
| BBCA             | 12,030,567,470 | 12,256,650,330 | 67.22%              | 66.79%             |
| BBRI             | 16,345,838,119 | 16,293,507,616 | 54.44%              | 54.51%             |
| TLKM             | 2,375,308,007  | 2,360,557,307  | 76.93%              | 76.96%             |

BSBK is the exception to "almost all ID": 2,341,713,397 corporate (CP) shares are local in KSEI's file and foreign in IDX's. The files say nothing about why the split differs; a nationality-versus-domicile difference in how the two products tag an account would produce this pattern, but that is a guess, not something any source here states.

**The 12 stocks whose type totals differ** (identical in all three months): TRIL (48,071,500 shares, IB vs OT, 4.0% of scripless), SRSN (133,427,500, IB vs OT, 2.2%), ATPK (0.6%), HOME (0.15%), and BTEL, TRUB, BNBR, GJTL, MTDL, LCGP, TMPI, BHIT at 0.01% or less.

### Against the classification report (962 stocks)

| Check                                                    | Aug 2026 | Sep 2026     | Oct 2026     |
| -------------------------------------------------------- | -------- | ------------ | ------------ |
| local + foreign total = `Total Scripless`                | 100%     | 100%         | 100%         |
| local total = sum of `Local_` columns, exact / within 1% | n/a      | 9.6% / 92.8% | 9.1% / 92.8% |
| type report local = sum of `Local_` columns              | n/a      | 100%         | 100%         |

The classification report's `Local_Individual (ID)` equals the type report's domestic ID (AADI Oct 2026: 1,651,905,480 in both; KSEI's file has 1,655,253,619).

**39 → 9.** With the 39 classes from the Sep and Oct split files, a greedy search over assignments of each class to one type (starting from the classes named after a type, then moving one class at a time while the count of exactly matching stock × origin × type cells rose) ended at 28,722 of 34,632 cells. Its mapping put Bank, Trustee Bank, Private Bank, Investment Advisors and Capital Market Supporting Institutions under IB; ETFs and Hedge Fund under MF; Investment Manager under SC; Educational Institution under FD; Government, Sovereign Wealth Fund, Central Bank, Cooperatives, Partnership, religious and social bodies under OT; Private Equity, Venture Capital, Brokerage Firms and the remaining company forms under CP. Applied to combined holdings it matched all nine type values exactly for 309–313 of 962 stocks (32%) and within 1% for 650–657 (68%), with KSEI's file and IDX's type report alike. Per type, within 1%: ID 100%, PF 99.9–100%, FD 100%, SC 99.3%, MF 96%, IS 93%, OT 87.5%, IB 80%, CP 72%. Only ID is exact for every stock. So no fixed mapping turns the panel's classes into the chart's types.

## History and layout

| File                             | Host                              | Lines | `EQUITY` rows (priced)    | Header |
| -------------------------------- | --------------------------------- | ----- | ------------------------- | ------ |
| `BalanceposEfek20080131.txt.zip` | `web.ksei.co.id`                  | 758   | 406 with `Type` `1` (405) | same   |
| `BalanceposEfek20090331.zip`     | both (same SHA-256)               | 757   | 420 (398)                 | same   |
| `BalanceposEfek20121228.zip`     | both (same SHA-256)               | 1,112 | 495 (463)                 | same   |
| `BalanceposEfek20151230.zip`     | `web.ksei.co.id` only             | 1,335 | 563 (527)                 | same   |
| `BalanceposEfek20170131.zip`     | `web.ksei.co.id` only             | 1,487 | 575 (539)                 | same   |
| `BalanceposEfek20200831.zip`     | `www`                             | 2,180 | 735 (715)                 | same   |
| `BalanceposEfek20201230.zip`     | both (different bytes, see below) | 2,182 | 750 (730)                 | same   |
| `BalanceposEfek20230831.zip`     | `www`                             | 2,758 | 924 (891)                 | same   |
| `BalanceposEfek20261030.zip`     | both (same SHA-256)               | 3,734 | 1,005 (962)               | same   |

The header line has the same MD5 in all of them, every equity row's types sum to its totals, and no equity value is fractional or empty. Only the security type vocabulary changed (`MEDIUM TERM NOTES` became `TERM NOTES` by Dec 2020; crowdfunding, structured warrants and SRBI appear later), which the `EQUITY` filter ignores.

**Where the files are.** `HEAD https://www.ksei.co.id/storage/Download/BalanceposEfek<date>.zip` returned `302 → /id` (not there) for all 14 month-ends tried in 2013–2017, and 200 for 2012-12-28, 2018-12-28, 2019-12-30 and later (this ticket and [the listing research](ksei-statistik-kepemilikan-listing.md)). The legacy Apache host answers for the same names, including 2015 and 2017, with the original upload time as `Last-Modified` (2015-12-30 file: `Mon, 04 Jan 2016 01:38:22 GMT`) and a 404 or 500 for a missing name. Every month was probed on the legacy host, then each name it found was checked on `www` with `HEAD`:

| Months              | `web.ksei.co.id/Download/`                | `www.ksei.co.id/storage/Download/`                                              |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| Jan 2008 – Feb 2009 | 200, named `BalanceposEfek<date>.txt.zip` | not probed (Wayback has these names under the old `/Download/` path)            |
| Mar 2009 – Apr 2013 | 200 for every month                       | 200 for every month                                                             |
| May 2013 – Dec 2017 | 200 for every month                       | `302 → /id` for every month (56)                                                |
| Jan 2018 – Oct 2026 | 200 for every month                       | 200 for every month checked (2018–2023 by name; Nov 2023 onward is the listing) |

The first pass tried the last seven weekdays of each month once and missed seven months (Mar and Apr 2015, Feb 2016, Jun 2017, Jul 2020, Aug 2021, May 2023). A second pass over every weekday, with retries, found all seven, so those were dropped connections, not gaps. Some period ends fall well before the calendar month end (`BalanceposEfek20170622.zip` for June 2017, `BalanceposEfek20201027.zip` for October 2020), so a backfill should take names from the legacy host's hits or from IDX's trading calendar rather than guess the last weekday.

Upload times on the legacy host (223 `Last-Modified` values, Jan 2008 – Oct 2026 less Oct–Dec 2008): 198 at 06:00 WIB (23:00 UTC); 98 on the calendar day after the period end and 73 three days after (a weekend between); 15 took six days or more, mostly around Lebaran, and the Jul 2025 file carries 2025-08-29, which looks like a re-upload. Zip size grew from about 35 KB (2008) to 126 KB (2026).

**User-Agent.** `www.ksei.co.id` answers a request whose `User-Agent` is `Python-urllib/3.x` with `301 → https://www.ksei.co.id/404`, for a file that answers 200 to curl's default agent and to `Mozilla/5.0`. A fetcher should send its own `User-Agent` and treat any 3xx as a miss.

**Corrections.** `BalanceposEfek20201230.zip` from `www` (81,068 bytes, inner file dated 2021-10-19 17:10) differs from the legacy host's copy (81,069 bytes, `Last-Modified: Thu, 31 Dec 2020 23:00:02 GMT`, inner file 2021-01-01 06:00). A line diff shows three changed rows, all `Sec. Num`: MSIN `520200000000` → `5202000000`, SSMM01B and SISSMM01 likewise divided by 100. So KSEI does fix old files, and the `www` store has the fixed copy. A backfill should read `www` first and fall back to the legacy host only for months `www` lacks.

## Publish lag

| Period end     | KSEI `BalanceposEfek` | IDX type report      | IDX classification report |
| -------------- | --------------------- | -------------------- | ------------------------- |
| Fri 2026-10-30 | Mon 2 Nov 07:08 WIB   | Mon 2 Nov 14:53 WIB  | Mon 2 Nov 14:53 WIB       |
| Wed 2026-09-30 | Thu 1 Oct 07:07 WIB   | Fri 2 Oct 13:53 WIB  | Fri 2 Oct 13:53 WIB       |
| Mon 2026-08-31 | Tue 1 Sep 07:07 WIB   | (2 Oct 11:38, batch) | (2 Oct 11:36, batch)      |

All times are `Last-Modified` converted to WIB (UTC+7). IDX's July and August monthly files carry 2 Oct 2026, the batch upload [the IDX listing research](idx-kepemilikan-listing.md#cadence) already noted, so they say nothing about August's lag. The IDX listing's `ListingDate` is the data date (`2026-10-30T12:00:00`), not an upload time. The legacy KSEI host shows the same pattern years back: most 2008–2011 files carry 23:00–23:55 UTC on the period end or the next calendar day, so about 06:00–07:00 WIB on the first morning after the period (one outlier: Sep 2008, uploaded 6 Oct).

## Where the chart and the panel can disagree

The Shareholders composition panel reads the classification report; a chart on KSEI's file can differ from it in three ways, and agrees in a fourth:

1. **Local vs foreign.** The largest. 69 of 962 stocks differ by more than 1 point of foreign share in Oct 2026, 10 by more than 10 (ACRO 3.1% vs 89.8%). The panel's figures match IDX's type report exactly, so this is a KSEI-file-versus-IDX difference, not a classification one.
2. **Type vs classification.** The chart's nine types are not a sum of the panel's classes, except Individual. A "Corporate" bar will not equal any grouping of the panel's corporate-like rows for about a third of stocks.
3. **Stock list.** KSEI's file has 43 unpriced equities the panel never shows; filter on `Price > 0`.
4. **Same totals and dates.** Scripless totals and data dates agree exactly, so percentages of scripless share one denominator, and the chart's newest month can appear a few hours to a day before the panel's.

## Sources

- KSEI files: `https://www.ksei.co.id/storage/Download/BalanceposEfek<date>.zip` for 20200831, 20201230, 20230831, 20260831, 20260930, 20261030 and 20121228; `https://web.ksei.co.id/Download/BalanceposEfek<date>.zip` for 20121228, 20151230, 20170131, 20201230, 20261030; `https://www.ksei.co.id/storage/Download/StatisEfek20261030.txt.zip`. `HEAD` on the month-ends listed above.
- IDX files: the six xlsx URLs above, downloaded from `www.idx.id`, and the listing `https://www.idx.id/primary/list/id/perusahaan-tercatat/data-kepemilikan-saham/?lang=id&start=0&length=9999` for `ListingDate`; `HEAD` on the Jan–Jul 2026 monthly files for `Last-Modified`.
- Month probes: `HEAD` with redirects off on `https://web.ksei.co.id/Download/BalanceposEfek<date>.zip` (and `.txt.zip` for Jan 2008 – Feb 2009) for the last weekdays of every month from Jan 2008 to Oct 2026, then `HEAD` with curl on `https://www.ksei.co.id/storage/Download/` for each name found in 2009–2023. Also downloaded: `BalanceposEfek20080131.txt.zip` (legacy) and `BalanceposEfek20090331.zip` (both hosts).
- Wayback Machine CDX for `ksei.co.id/Download/BalanceposEfek*` (2008–2012 and 2017 captures), used only to find names to probe.
- Earlier research: [How KSEI serves the Statistik Efek and Kepemilikan Efek listings](ksei-statistik-kepemilikan-listing.md) and [How IDX serves the Data Kepemilikan Saham listing](idx-kepemilikan-listing.md).
