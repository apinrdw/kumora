# What IDX's investor-type report holds, and what its ≥5% band means

Research for [#395](https://github.com/apinrdw/kumora/issues/395), part of the map [#394](https://github.com/apinrdw/kumora/issues/394). Read on 2026-11-16 (a Monday) from a machine in Indonesia. Every claim below comes from parsing files that IDX and KSEI served on that date, unless it cites another source. The scripts were throwaway Python (stdlib only: `zipfile` plus regexes over `xl/sharedStrings.xml` and `xl/worksheets/sheet1.xml`, the same reading as [#351](https://github.com/apinrdw/kumora/issues/351)). Each result says how it was computed so a reader can redo it.

## Answer

- **Two layouts, each with one exact header.** Nov–Dec 2025 have a 2-row header and 22 columns (`A`–`V`). Jan–Oct 2026 have a 3-row header and 40 columns (`A`–`AN`), `DOMESTIC` then `FOREIGN`. Within each layout, the header text is identical in every file. The shares column is `JUMLAH_SAHAM_BEREDAR` in the old layout and `NUMBER_OF_SHARES` in the new one. The total column is `TOTAL_SAHAM_SCRIPLESS` in the old layout and `TOTAL SCRIPLESS` (with a space) in the new one. No file has a value past the last labelled column. Two files have empty styled cells past it (Apr 2026 to `AP`, Jun 2026 to `AO`), and two files have empty rows at the end (Feb 2026, Jun 2026).
- **Every row sums exactly.** In all 12,038 data rows of the 12 files, the 18 type cells (unsplit) or 36 type cells (split) sum exactly to total scripless, with blank cells read as 0. Every value is a non-negative integer. Total scripless is never more than shares outstanding.
- **Blank means 0.** Nov 2025 through **Apr 2026** (not only Nov 2025) leave a cell blank where the stock has no holding of that type. From May 2026 the same cell is `0`. Blanks always come in pairs: when one band of a type is blank, the other band is blank too, and no pair in a blank-era file is `0`/`0`. Of Apr 2026's 8,267 blank pairs on stocks still listed in May, 8,179 are `0`/`0` in May. A parser can read blank as 0 and lose nothing.
- **The ≥5% band follows a per-investor rule, and no source documents it.** IDX's and KSEI's files, listing and press release define no `<5%` / `>=5%`. The data fits this rule: shares count in `>=5%` when the investor (by SID) holds, **in scripless shares, at least 5% of the stock's listed shares** (`NUMBER_OF_SHARES`), summed across all of that investor's sub-accounts. Exactly 5.00% counts. Scrip shares are left out of the test. Tested against IDX's month-end above-1% reports, the rule reproduces the type report's `>=5%` total exactly for 950 of 955 stocks (Mar 2026), 957 of 961 (Sep 2026) and 957 of 961 (Oct 2026). In every miss, part of a big investor's holding sits in `<5%` under a different type. That part is under 5% of listed shares in every case, so the test probably runs per investor **and type**. See [The ≥5% band](#the-5-band).
- **It matches the daily above-5% report.** On 30 Oct 2026, the stocks with any `>=5%` holding in the type report (844) are the stocks in IDX's daily "Pemegang Saham di Atas 5%" report (843), apart from MSKY. That report is titled "KEPEMILIKAN EFEK DIATAS 5% BERDASARKAN SID", so it also counts by investor, not by account.
- **KSEI's `BalanceposEfek` agrees on everything but the local/foreign split, every month.** For all 12 months:
  - Both files list the same equity codes.
  - Total scripless matches for 100% of stocks.
  - Shares outstanding matches KSEI's `Sec. Num` for 100% of stocks, except LPPF in Jun 2026.
  - All nine types, local + foreign combined, match exactly for 98.2–98.8% of stocks and within 1% of scripless for 99.7–99.8%.
  - Local total vs domestic total matches for only 9–12% of stocks. All 18 type × origin cells match for 9–12%.
  - Market-wide, the foreign share of scripless is 0.07–0.15 points higher in IDX's report (Oct 2026: 30.52% vs 30.40%).

  This is the pattern [#357](https://github.com/apinrdw/kumora/issues/357) found for Aug–Oct 2026, and it holds back to Nov 2025.

- **Row anomalies a parser must handle:**
  - No duplicate codes, and every row is an equity. The 5-letter codes `EDJSA`, `EDJSB`, `MAMIP` and `MYRXP` are share classes ([#357](https://github.com/apinrdw/kumora/issues/357)).
  - Apr 2026 writes **`TRUE` as a boolean cell** (`t="b"`, value `1`). Excel's TRUE autocorrect hit the code, and IDX's 1% and 5% reports for 30 Oct 2026 have the same bug.
  - Stocks join and leave: Dec 2025 +RLCO, SUPA. Apr 2026 −SIMM, +WBSA. Jul 2026 +BACH, EMMI, JECX, JELI, PRDL, RANS, −CNTX. Sep 2026 −SQBB, SQBI. No stock leaves and comes back, apart from the TRUE artifact.

## The files

The 12 files are the "Data Kepemilikan Saham Perusahaan Tercatat per Tipe Investor" entries in the listing from [How IDX serves the Data Kepemilikan Saham listing](idx-kepemilikan-listing.md). Each was fetched from `www.idx.id` with the same path as the listed `www.idx.co.id` URL:

| Period     | Path under `https://www.idx.id/Media/`  | `DATE` serial | Data rows |
| ---------- | --------------------------------------- | ------------- | --------- |
| 2025-11-28 | `o5hdz012/peng-11-00004-tipe.xlsx`      | 45989         | 1,000     |
| 2025-12-30 | `dnkd1ldv/peng-12-00005-tipe.xlsx`      | 46021         | 1,002     |
| 2026-01-30 | `kikeeibw/peng-01-00006-tipe.xlsx`      | 46052         | 1,002     |
| 2026-02-27 | `b2rfacn2/peng-02-00007-tipe.xlsx`      | 46080         | 1,002     |
| 2026-03-31 | `swncwedd/peng-03-00008-tipe.xlsx`      | 46112         | 1,002     |
| 2026-04-30 | `5occkkly/peng-04-00009-tipe.xlsx`      | 46142         | 1,002     |
| 2026-05-29 | `uvlhrjjj/peng-05-00010-tipe.xlsx`      | 46171         | 1,002     |
| 2026-06-30 | `hchb1w2p/peng-06-00017-tipe.xlsx`      | 46203         | 1,002     |
| 2026-07-31 | `5jnhnjcx/peng-2026-07-00020-tipe.xlsx` | 46234         | 1,007     |
| 2026-08-31 | `wkjfudt3/peng-2026-08-00022-tipe.xlsx` | 46265         | 1,007     |
| 2026-09-30 | `2ygosvbp/peng-2026-09-00025-tipe.xlsx` | 46295         | 1,005     |
| 2026-10-30 | `jv2jkbtd/peng-2026-10-00027-tipe.xlsx` | 46325         | 1,005     |

Each file has one sheet, `xl/worksheets/sheet1.xml`. `DATE` is an Excel serial day (1900 system: day 0 is 1899-12-30), the same on every row, and it equals the listing's period date in all 12 files. Rows are sorted by `STOCK_CODE`.

## Header layouts

Row 1 holds one string in `A1`: "KSEI is the central depository and settlement institution in the Indonesia Capital Market, therefore KSEI is not authorized to determine the free float shares." (Dec 2025 also writes 21 empty cells `B1:V1`.) This is the only note in the file. It has no legend for the bands.

### Unsplit: Nov–Dec 2025 (data from row 4)

| Row | `A`                 | `B`          | `C`                    | `D`–`U`                                                         | `V`                     |
| --- | ------------------- | ------------ | ---------------------- | --------------------------------------------------------------- | ----------------------- |
| 2   | `DATE`              | `STOCK_CODE` | `JUMLAH_SAHAM_BEREDAR` | a type label in `D`, `F`, `H` … `T`, each merged over 2 columns | `TOTAL_SAHAM_SCRIPLESS` |
| 3   | (merged from row 2) |              |                        | `<5%`, `>=5%` alternating                                       | (merged)                |

### Split: Jan–Oct 2026 (data from row 5)

| Row | `A`    | `B`          | `C`                | `D`–`U`                          | `V`–`AM`                    | `AN`                                 |
| --- | ------ | ------------ | ------------------ | -------------------------------- | --------------------------- | ------------------------------------ |
| 2   | `DATE` | `STOCK_CODE` | `NUMBER_OF_SHARES` | `DOMESTIC` (merged `D2:U2`)      | `FOREIGN` (merged `V2:AM2`) | `TOTAL SCRIPLESS` (merged `AN2:AN4`) |
| 3   |        |              |                    | type labels, each over 2 columns | type labels                 |                                      |
| 4   |        |              |                    | `<5%`, `>=5%` alternating        | `<5%`, `>=5%`               |                                      |

The nine type labels, in file order (alphabetical by code, unlike KSEI's `IS CP PF IB ID MF SC FD OT`):

`CP: Corporate (perusahaan terbatas)`, `FD: Foundation (yayasan)`, `IB: Financial Institution (institusi keuangan)`, `ID: Individual`, `IS: Insurance (asuransi)`, `MF: Mutual Fund (reksa dana)`, `OT: Others`, `PF: Pension Fund (pengelola dana pensiun)`, `SC: Securities Company (perusahaan sekuritas)`.

Every type has `<5%` first, then `>=5%`. The header cells were compared as strings across files: the 2 unsplit files are identical, and so are the 10 split files.

### Stray cells and rows

| File     | What                                                                     | Values         |
| -------- | ------------------------------------------------------------------------ | -------------- |
| Feb 2026 | Row 1007 is present but empty (sheet `dimension` `A1:AN1007`)            | none           |
| Apr 2026 | Row 4 has styled cells to `AP` (`dimension` `A1:AP1006`)                 | none past `AN` |
| Jun 2026 | No row 1007. Rows 1008–1011 are empty. Row 558 has a styled cell in `AO` | none past `AN` |

A parser that finds the header by its labels, reads up to the total column, and skips rows with an empty `STOCK_CODE` handles all three. #351 gave the same advice for the classification report.

## Values

Method: for each data row, read `C` (shares), the type cells and the total, treating a missing `<v>` as blank.

- Every value cell is a numeric cell (`t` absent) holding a whole number. There are no strings, decimals or negatives.
- Sum check: the type cells, blank as 0, equal the total in **12,038 of 12,038 rows**.
- Total scripless ≤ shares outstanding in every row. They are equal (a stock with no scrip shares) in 28–32% of rows: 283 of 1,000 in Nov 2025, rising to 320 of 1,005 in Oct 2026.

### Blank vs 0

Each (type, origin) pair of `<5%` / `>=5%` cells was classed per stock:

| Month    | blank pair | `0`/`0` | `x`/`0` | `0`/`x` | `x`/`x` |
| -------- | ---------- | ------- | ------- | ------- | ------- |
| Nov 2025 | 2,695      | 0       | 5,114   | 45      | 1,146   |
| Dec 2025 | 2,698      | 0       | 5,121   | 43      | 1,156   |
| Jan 2026 | 8,155      | 0       | 8,579   | 108     | 1,194   |
| Feb 2026 | 8,199      | 0       | 8,534   | 108     | 1,195   |
| Mar 2026 | 8,260      | 0       | 8,470   | 110     | 1,196   |
| Apr 2026 | 8,279      | 0       | 8,452   | 112     | 1,193   |
| May 2026 | 0          | 8,268   | 8,458   | 115     | 1,195   |
| Jun 2026 | 0          | 8,296   | 8,421   | 123     | 1,196   |
| Jul 2026 | 0          | 8,388   | 8,408   | 121     | 1,209   |
| Aug 2026 | 0          | 8,351   | 8,439   | 117     | 1,219   |
| Sep 2026 | 0          | 8,251   | 8,511   | 105     | 1,223   |
| Oct 2026 | 0          | 8,284   | 8,467   | 105     | 1,232   |

No pair is ever half blank. Up to Apr 2026, "no holding of this type" is written as a blank pair. From May 2026 it is `0`/`0`. A band alone is written `0`, never blank. Apr → May, for stocks in both files: 8,179 blank pairs became `0`/`0`, 87 became `x`/`0` and 1 became `0`/`x`. That is new holdings in a month, not a change of meaning. `0`/`x` (a type held only by ≥5% holders) is real: 45–123 pairs a month.

## The ≥5% band

### No source defines it

- The type report's only note is the free-float disclaimer.
- The listing entry is only a title ("Data Kepemilikan Saham Perusahaan Tercatat per Tipe Investor per …").
- The joint IDX–KSEI press release of 5 Feb 2026 ([PR-001/KSEI/SKE/0226](https://www.ksei.co.id/storage/208111/001_Press-Release-Tindak-Lanjut-Koordinasi-Pasar-Modal-Indonesia-dengan-....pdf)) says only that disclosure "tidak lagi terbatas pada kepemilikan di atas 5%" and announces the monthly above-1% report.

Two primary statements bear on it:

- IDX's above-1% report, disclaimer item 4: "Ownership calculations are performed based on SID or based on Account numbers for Shareholder who do not yet hold an SID."
- IDX's daily above-5% report is titled "KEPEMILIKAN EFEK DIATAS 5% BERDASARKAN SID". It lists each investor's sub-accounts, with a column "Saham Gabungan Per Investor" (combined shares per investor) and the percentage per investor.

So KSEI's 5% line is drawn per investor (SID). The data then fixes the rest.

### Tested against the above-1% report

Files:

- `https://www.idx.id/Media/1ivhzj1q/peng-03-00012-satu-persen.xlsx` (Mar 2026; the header names `INVESTOR_TYPE`, the 9 type codes)
- `.../yqjhhsee/peng-2026-09-00024-satu-persen.xlsx` (Sep 2026)
- `.../wlef2nvt/peng-2026-10-00029-satu-persen.xlsx` (Oct 2026; Sep and Oct have `INVESTOR_CLASSIFICATION` with the 39 classes instead)

Each row is one investor of one stock, with `LOCAL_FOREIGN` (`L` or `F`), `HOLDINGS_SCRIPLESS`, `HOLDINGS_SCRIP`, `TOTAL_HOLDING_SHARES` and `PERCENTAGE`. Per stock, the scripless holdings of the investors that pass a candidate rule were summed and compared with the type report's `>=5%` cells. All results below are for Oct 2026, on the 961 stocks in both reports:

| Rule for "≥5% holder"                           | Stocks whose `>=5%` total matches exactly              |
| ----------------------------------------------- | ------------------------------------------------------ |
| `HOLDINGS_SCRIPLESS` ≥ 5% of `NUMBER_OF_SHARES` | **957**                                                |
| `PERCENTAGE` ≥ 5 (scrip + scripless)            | 837 of 1,005 (incl. stocks missing from the 1% report) |
| `TOTAL_HOLDING_SHARES` ≥ 5% of listed           | 848 of 1,005                                           |
| `HOLDINGS_SCRIPLESS` ≥ 5% of total scripless    | 653 of 1,005                                           |

With the first rule, the local/foreign split matches too: domestic `>=5%` = `L` investors, foreign = `F` investors, for the same 957 stocks. Mar 2026 gives 950 of 955. Its `INVESTOR_TYPE` column also lets each of the 18 type × origin `>=5%` cells be checked, and all 18 match for 948 of 955 stocks.

Boundary cases, Oct 2026:

- BSSR: PT GS Global Resources holds 130,825,000 scripless shares, exactly 5.0000% of 2,616,500,000 listed, and they appear as BSSR's domestic CP `>=5%`.
- CINT: two individuals hold exactly 50,000,000 each (5.0000% of 1,000,000,000), and CINT's domestic ID `>=5%` is 100,000,000.
- APLN: an investor at 4.9988% of listed is not counted.

So the test is `>=`, against listed shares.

Scrip is excluded both from the test and from the band. CINT's PT Tritirta Inti Mandiri holds 53.26% in total, but only 33,918,000 scripless shares (3.39%). Those shares sit in `<5%`. This makes sense, because the report only covers scripless holdings.

### The misses: investor and type

The same few stocks miss in all three months. In each case the 1% report's investor holds more scripless shares than the type report puts in `>=5%`:

| Stock | Month         | Investor (1% report)                      | Excess over the `>=5%` cell                       | Excess as % of listed |
| ----- | ------------- | ----------------------------------------- | ------------------------------------------------- | --------------------- |
| SQMI  | Mar, Sep, Oct | Wilton Resources Holding (foreign CP)     | 620,000,000, equal to SQMI's foreign **OT** `<5%` | 3.99%                 |
| MYOH  | Mar, Sep, Oct | ST International Corporation (foreign OT) | 98,342,916                                        | 4.46%                 |
| WINS  | Mar, Sep, Oct | PT Wintermarjaya Lestari (domestic CP)    | 204–207 million                                   | 4.58%                 |
| PICO  | Mar, Sep, Oct | two domestic CP holders                   | 18–28 million                                     | 3.19–4.95%            |
| BSDE  | Mar           | PT Paraga Artamida (domestic CP)          | 621,055,400                                       | 2.93%                 |

Each excess is under 5% of listed shares. In SQMI's case it equals another type's `<5%` cell to the share. The type report assigns a type per sub-account, because each account holder classifies its own client. The 1% report's disclaimer item 8 says so: "The determination of investor classification is carried out by each KSEI Account Holder". The 1% report gives each investor one type. So the reading that fits every stock is that **the 5% test runs per investor per type**: an investor's scripless shares in accounts of one type, summed, against 5% of listed shares. That explains all 5 misses. A plain per-investor test explains none of them.

The two other Mar 2026 cell misses, LPPF and SRAJ, split one investor's `>=5%` shares between two types. For example, SRAJ's High Pro Investments shows 1,110,281,464 as foreign OT and 1,069,711,538 as foreign CP, each ≥5% (9.07% and 8.74%). That fits the same reading. It rests on 5 stocks and on no document, so treat it as inferred.

For a display this hardly matters. In Oct 2026 the misses move 0.9 billion shares out of 5.87 trillion in `>=5%`. Market-wide, `>=5%` holds 51.2–52.2% of scripless shares from Nov 2025 to Aug 2026, and 55.3–55.7% in Sep–Oct 2026.

### Against the daily above-5% report (30 Oct 2026)

File: `https://www.idx.id/Media/t4qnuz2a/peng-2026-10-30-00107-lima-persen.xlsx`.

- The type report has 844 stocks with a `>=5%` holding. The daily report lists 843 stocks.
- With `1` read as `TRUE`, the only difference is **MSKY**. It is in the type report (domestic CP `>=5%` 1,347,740,000, 67.6% of listed) and not in the daily report.
- A per-stock share comparison was not reliable. The daily report merges cells across an investor's sub-account rows, includes scrip, and prints some small sub-account amounts in a different format (`29.7`, `803.5`). Summing its "Saham Gabungan Per Investor" column matched the type report's `>=5%` total for 943 of 1,005 stocks. The 1% report is the cleaner check, and it is the one used above.

## Against KSEI's `BalanceposEfek`

Files: `https://www.ksei.co.id/storage/Download/BalanceposEfek<YYYYMMDD>.zip` for all 12 period dates (see [How KSEI serves the Kepemilikan Efek files](ksei-statistik-kepemilikan-listing.md)). The method is #357's ([KSEI's file compared with IDX's reports](https://github.com/apinrdw/kumora/blob/research/ksei-holdings-vs-idx/docs/research/ksei-holdings-vs-idx.md)): keep `Type == "EQUITY"` and join on code. A type's value is `<5%` + `>=5%`. "Within 1%" means within 1% of the stock's scripless.

| Month    | Stocks (both) | Listed = `Sec. Num` | Scripless = local + foreign | 9 types combined, exact | within 1% | Local total exact | All 18 exact | Foreign share IDX / KSEI |
| -------- | ------------- | ------------------- | --------------------------- | ----------------------- | --------- | ----------------- | ------------ | ------------------------ |
| Nov 2025 | 1,000         | 1,000               | 1,000                       | 982                     | 997       | n/a (unsplit)     | n/a          | n/a                      |
| Dec 2025 | 1,002         | 1,002               | 1,002                       | 984                     | 999       | n/a               | n/a          | n/a                      |
| Jan 2026 | 1,002         | 1,002               | 1,002                       | 985                     | 999       | 118               | 117          | 37.12% / 37.05%          |
| Feb 2026 | 1,002         | 1,002               | 1,002                       | 990                     | 1,000     | 109               | 108          | 36.72% / 36.61%          |
| Mar 2026 | 1,002         | 1,002               | 1,002                       | 990                     | 1,000     | 93                | 92           | 36.49% / 36.36%          |
| Apr 2026 | 1,002         | 1,002               | 1,002                       | 990                     | 1,000     | 91                | 90           | 36.24% / 36.11%          |
| May 2026 | 1,002         | 1,002               | 1,002                       | 990                     | 1,000     | 107               | 105          | 36.50% / 36.37%          |
| Jun 2026 | 1,002         | **1,001**           | 1,002                       | 990                     | 1,000     | 116               | 114          | 35.73% / 35.59%          |
| Jul 2026 | 1,007         | 1,007               | 1,007                       | 995                     | 1,005     | 118               | 117          | 35.06% / 34.91%          |
| Aug 2026 | 1,007         | 1,007               | 1,007                       | 995                     | 1,005     | 118               | 117          | 35.19% / 35.07%          |
| Sep 2026 | 1,005         | 1,005               | 1,005                       | 993                     | 1,003     | 109               | 108          | 31.39% / 31.32%          |
| Oct 2026 | 1,005         | 1,005               | 1,005                       | 993                     | 1,003     | 105               | 104          | 30.52% / 30.40%          |

- **The equity sets are identical every month.** The TRUE row in Apr 2026 joins once `1` is read as `TRUE`.
- **The one listed-shares difference** is LPPF in Jun 2026: IDX 2,227,279,280, KSEI 2,258,279,280. IDX already shows the lower count that both carry from Jul 2026, so the two sources can disagree for a month after a share-count change.
- **Market-wide type × origin totals, Oct 2026** (summed over the 1,005 stocks, shares):

  | Type | IDX domestic      | KSEI local        | IDX foreign       | KSEI foreign      | Combined difference |
  | ---- | ----------------- | ----------------- | ----------------- | ----------------- | ------------------- |
  | CP   | 4,288,012,903,352 | 4,290,359,741,819 | 1,497,974,650,021 | 1,495,627,815,182 | −3,628              |
  | FD   | 5,838,679,798     | 5,838,679,798     | 1,754,902,763     | 1,754,902,763     | 0                   |
  | IB   | 94,783,140,509    | 94,783,140,509    | 758,016,086,993   | 757,826,972,943   | +189,114,050        |
  | ID   | 2,273,275,250,337 | 2,282,587,253,788 | 76,973,750,370    | 67,698,264,419    | −36,517,500         |
  | IS   | 198,937,116,107   | 198,937,116,107   | 22,111,530,482    | 22,111,530,482    | 0                   |
  | MF   | 139,645,420,456   | 139,645,432,956   | 305,118,648,686   | 305,118,636,186   | 0                   |
  | OT   | 99,073,399,347    | 99,073,396,777    | 321,827,376,354   | 321,979,972,346   | −152,593,422        |
  | PF   | 27,916,906,683    | 27,916,906,683    | 62,617,123,731    | 62,617,123,731    | 0                   |
  | SC   | 196,888,739,186   | 196,888,738,686   | 170,212,070,050   | 170,212,070,050   | +500                |

  The ID gap is #357's Individual shift: KSEI puts about 9.3 billion shares on the local side that IDX counts as foreign. Nov 2025's combined differences are the same for ID, OT and SC. CP (−2.99 billion) and IB (+3.18 billion) are larger then and nearly cancel, so some holdings sat in IB in one file and CP in the other. By Oct 2026 that gap has shrunk to the figures above.

- **KSEI has no band.** The `<5%` / `>=5%` split exists only in IDX's report. This is the one thing the type report adds over `BalanceposEfek`, as map #394 says.

## Stocks per month

| Month        | Rows  | Added                              | Removed         |
| ------------ | ----- | ---------------------------------- | --------------- |
| Nov 2025     | 1,000 |                                    |                 |
| Dec 2025     | 1,002 | RLCO, SUPA                         |                 |
| Jan–Mar 2026 | 1,002 |                                    |                 |
| Apr 2026     | 1,002 | WBSA (and `1` for TRUE)            | SIMM (and TRUE) |
| May 2026     | 1,002 | (TRUE back)                        | (`1`)           |
| Jun 2026     | 1,002 |                                    |                 |
| Jul 2026     | 1,007 | BACH, EMMI, JECX, JELI, PRDL, RANS | CNTX            |
| Aug 2026     | 1,007 |                                    |                 |
| Sep 2026     | 1,005 |                                    | SQBB, SQBI      |
| Oct 2026     | 1,005 |                                    |                 |

- **Stocks.** No code appears twice in a file. Every row is an equity: all codes are 4 letters, plus `EDJSA`, `EDJSB`, `MAMIP` and `MYRXP` in every month. As #357 found, the type report's list is KSEI's whole `EQUITY` list, including about 43 unpriced (delisted or long-suspended) stocks that the classification report leaves out. The above-1% report also leaves out 44–47 of the type report's stocks, and 38–41 of those still have `>=5%` holdings in the type report.
- **The TRUE code.** In Apr 2026, row 944's `STOCK_CODE` is `<c t="b"><v>1</v></c>`, a boolean. A parser that reads only shared strings for the code drops TRUE for that month, and one that stringifies the cell gets `1`. Map a boolean `1` in the code column to `TRUE`. IDX's above-1% and above-5% reports for 30 Oct 2026 carry the same boolean, so expect it in IDX xlsx files generally.
