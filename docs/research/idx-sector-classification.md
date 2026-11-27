# Where the IDX-IC sector of every stock code comes from

Research for [#410](https://github.com/apinrdw/kumora/issues/410), part of the map [#409](https://github.com/apinrdw/kumora/issues/409) (Market Bubbles). Read on 2026-11-16 (a Monday) from a machine in Indonesia. Every claim below comes from a live, unauthenticated request to IDX on that date unless it cites another source.

## Answer

- **Source:** IDX's own listed-company profile API, the one behind the "Profil Perusahaan Tercatat" page. One call returns every listed stock with its full IDX-IC path: sector, sub-sector, industry and sub-industry.

  ```
  GET https://www.idx.id/primary/ListedCompany/GetCompanyProfiles?emitenType=s&start=0&length=9999&lang=en
  ```

- **Coverage:** 944 stock codes, the same 944 that IDX's stock list (`GetSecuritiesStock`) returns. All 944 have a sector, a sub-sector, an industry and a sub-industry. None is blank.
- **Format:** JSON, 864 KB raw and about 149 KB gzipped. `lang=en` gives English names ("Energy", "Financials"), which matches Kumora's English-only page copy. With no `lang`, the names are Indonesian. Industry and sub-industry come in the same call, so they cost nothing extra.
- **Fetch:** `www.idx.id` serves it with no Cloudflare challenge. The production Worker already reads the shareholding listing from this host (`apps/dashboard/src/server/shareholding/listing.ts`).
- **Freshness:** IDX applies a batch of reclassifications once a year, in late June (announcements Peng-00110/BEI.POP/06-2025 and Peng-00100/BEI.POP/06-2026), plus one-off changes and new listings at any time. The response has no "changed at" field, so a daily refresh that replaces the whole table is the simplest way to stay current.
- **Terms of use:** IDX's Terms of Use forbid scraping and crawling, and forbid commercial use without written consent (see [Terms of use](#terms-of-use)). The same terms already cover Kumora's shareholding archive. The owner decides whether a once-a-day read of one JSON file is acceptable.
- **Recommendation:** a Production-only daily cron reads that one URL and replaces a `stock_sector` table in D1. The dashboard serves the table as one cached JSON map from stock code to sector. A code with no row, or with a sector outside the 11 IDX-IC sectors, goes into an **Unclassified** bucket (see [Fallback](#fallback-for-a-code-with-no-sector)).

## The endpoint

### How it was found

The page `https://www.idx.id/id/perusahaan-tercatat/profil-perusahaan-tercatat/` is the same Nuxt 2 app described in [idx-kepemilikan-listing.md](idx-kepemilikan-listing.md). Its bundle loads the table like this (de-minified):

```js
await this.$axios.get("/primary/ListedCompany/GetCompanyProfiles", {
  params: { kodeEmiten: this.selectedEmiten.KodeEmiten, emitenType: this.selectedCompanyType.val, start: this.page - 1, length: 9999 },
})
```

The picker fills from `GET /primary/Helper/GetEmiten?emitenType=s`, which returns `[{ KodeEmiten, NamaEmiten }]`.

### Request and response

```
GET https://www.idx.id/primary/ListedCompany/GetCompanyProfiles?emitenType=s&start=0&length=9999&lang=en

HTTP/2 200
content-type: application/json; charset=utf-8
cache-control: public, max-age=300
server: cloudflare
```

```json
{
  "draw": 0,
  "recordsTotal": 944,
  "recordsFiltered": 944,
  "data": [
    {
      "KodeEmiten": "AADI",
      "NamaEmiten": "PT Adaro Andalan Indonesia Tbk",
      "Sektor": "Energy",
      "SubSektor": "Oil, Gas & Coal",
      "Industri": "Coal",
      "SubIndustri": "Coal Production",
      "PapanPencatatan": "Main",
      "TanggalPencatatan": "2024-12-05T00:00:00",
      "Logo": "/Portals/0/StaticData/ListedCompanies/LogoEmiten/AADI.jpg",
      "...": "address, phone, email, website, NPWP, share registrar, main business"
    }
  ]
}
```

The record also carries contact fields (address, phone, email, NPWP). Kumora needs none of them and should not store them. `Logo` is a path on the IDX site. It may answer the logo research ticket in the same map.

### Parameters

| Parameter         | Effect (observed)                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emitenType`      | `s` means stocks. Omitting it returned the same 944.                                                                                                  |
| `start`, `length` | Paging, as on the shareholding listing. `length=9999` returns everything in one call.                                                                 |
| `lang`            | `en` returns English names for sector, sub-sector, industry and sub-industry. `language=en-us`, which `GetSecuritiesStock` takes, has no effect here. |
| `kodeEmiten`      | Filters to one stock code. It also returns records that the full list leaves out (see [Gaps](#gaps-in-the-full-list)).                                |
| `sector`          | Ignored: the full 944 come back.                                                                                                                      |

### What it holds

The 11 sectors, with the number of stock codes in each:

| English (`lang=en`)       | Indonesian (default)       | Codes |
| ------------------------- | -------------------------- | ----- |
| Consumer Cyclicals        | Barang Konsumen Non-Primer | 155   |
| Consumer Non-Cyclicals    | Barang Konsumen Primer     | 132   |
| Basic Materials           | Barang Baku                | 113   |
| Financials                | Keuangan                   | 105   |
| Properties & Real Estate  | Properti & Real Estat      | 91    |
| Energy                    | Energi                     | 89    |
| Infrastructures           | Infrastruktur              | 69    |
| Industrials               | Perindustrian              | 65    |
| Technology                | Teknologi                  | 44    |
| Healthcare                | Kesehatan                  | 41    |
| Transportation & Logistic | Transportasi & Logistik    | 40    |

Below the sector there are 33 sub-sectors, 58 industries and 102 sub-industries. Each Indonesian sector name maps to exactly one English name across all 944 codes. IDX-IC's twelfth sector, Listed Investment Products (ETFs and the like), does not appear because `emitenType=s` returns stocks only.

The response has no IDX-IC letter codes (A to K), so Kumora would key sectors by the English name or by its own slug. Names have no stray whitespace today, but trim them before use as a precaution, as with the shareholding listing.

The newest `TanggalPencatatan` (listing date) in the response is 2026-07-10 (RANS). I did not check whether IDX listed any new stock after that date and the profile is missing it.

### Gaps in the full list

`Helper/GetEmiten?emitenType=s` returns 946 codes. Two of them, `TKGA` and `TMPI`, are not in the full profile list. With `kodeEmiten=TKGA`, the API returns a record with the **pre-2021 JASICA** classification and a blank industry:

```json
{ "KodeEmiten": "TKGA", "Sektor": "TRADE, SERVICES & INVESTMENT", "SubSektor": "RETAIL TRADE", "Industri": "", "SubIndustri": "", "PapanPencatatan": "PENGEMBANGAN" }
```

`TMPI` looks the same. Both look like stale records of long-suspended issuers. They show why Kumora must check every sector against the 11 IDX-IC names and not trust any non-empty string.

## Freshness

- **Reclassifications:** a search of IDX announcements for "Klasifikasi Industri" (`/primary/NewsAnnouncement/GetAllAnnouncement`) found a yearly batch, "Perubahan Klasifikasi Industri Perusahaan Tercatat", on 2025-06-23 and 2026-06-24. It also found one-off notices per issuer, such as seven "Perubahan Nama / Kode / Sektor dan Sub Sektor" notices on 2025-01-22 (MDKA, PANI and others). I did not read the PDFs to see how long the profile API takes to reflect a change.
- **New listings and delistings:** the profile list and `GetSecuritiesStock` held the same 944 codes, so the two endpoints draw from the same data.
- **Caching:** the response is `cache-control: public, max-age=300`. A daily read is far gentler than the page's own traffic.

So the API has no change feed. A daily full replace catches a reclassification within a day of IDX updating its profile. Kumora's sector filter needs nothing faster.

## Terms of use

From `https://www.idx.id/en/terms-of-use/` (CMS record `/primary/page/en/terms-of-use/`):

> Users are prohibited from using or disseminating Information and or data obtained from Website to other parties for commercial purpose without prior written consent from Indonesia Stock Exchange [...]. The use of Information, including information and or data citation not for commercial purposes is permitted by mentioning the complete source accompanied with the date of Users access citing such information and or data on Website and do not use the web scrapping/crawling method.

What this means for Kumora:

- Non-commercial use is allowed if the source and access date are shown. The bubble page can show "Sector: IDX-IC, idx.co.id, as of <fetched date>".
- Commercial use needs IDX's written consent. A licensed feed (IDX Data Services, or TICMI for history) is the formal route. I did not look up its prices.
- The ban on "web scrapping/crawling" is the open risk. One request a day to a JSON endpoint that IDX's own page calls is not crawling in the usual sense, but the terms do not define the word. Kumora's shareholding archive already reads `www.idx.id` under the same terms, so this adds no new kind of exposure.

## Other sources compared

| Source                                                                   | Coverage                                                                           | Freshness                       | Format                                        | Terms / access                                                                                   | Verdict                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IDX `GetCompanyProfiles`**                                             | All 944 stocks, four IDX-IC levels                                                 | IDX's own record; refresh daily | One JSON call                                 | IDX Terms of Use (above); no login                                                               | **Recommended**                                                                                                                                                                                |
| IDX `GetSecuritiesStock`                                                 | Same 944 codes                                                                     | Same                            | JSON: code, name, listing date, shares, board | Same                                                                                             | No sector field. Its `sector` filter takes English names (`sector=Energy` returned 89), so it could rebuild the map with 11 calls, but that only repeats `GetCompanyProfiles` with more steps. |
| IDX sector index constituents (IDXENERGY and so on)                      | Sector only                                                                        | Changes at index reviews        | Per-index files                               | Same                                                                                             | Worse: 11 files to merge, and no industry level. Not probed.                                                                                                                                   |
| Stockbit `/emitten/classification/company`                               | Unknown                                                                            | Unknown                         | JSON                                          | Needs a signed-in token; `exodus.stockbit.com` answered 403 unauthenticated. Broker terms apply. | Not usable without the owner's session. Named in [stockbit-live-data.md](stockbit-live-data.md).                                                                                               |
| Ajaib `GET /api/v1/stock/data/list/`                                     | All codes; [ajaib-live-data.md](ajaib-live-data.md) records only `code` and `name` | Cached 1 h by the app           | JSON                                          | Needs the JWT                                                                                    | No sector field is known to exist.                                                                                                                                                             |
| Live running-trade feeds (Stockbit `running_trade_batch`, Ajaib `TRADE`) | Every traded code                                                                  | Live                            | Per trade                                     | Via the relay extension                                                                          | Neither record has a sector field ([stockbit-live-data.md](stockbit-live-data.md), [ajaib-live-data.md](ajaib-live-data.md)). They are a source of codes, not of sectors.                      |
| Public datasets (GitHub CSVs, Kaggle, Wikipedia)                         | Varies                                                                             | Usually a one-time snapshot     | CSV                                           | Mixed, and usually derived from IDX anyway                                                       | Secondary and stale. Rejected without probing.                                                                                                                                                 |

## How Kumora would fetch and store it

1. **Fetch.** A Production-only cron, gated like the other IDX crons in `apps/dashboard/alchemy.run.ts`, sends one GET to the URL above with `lang=en`. Use the capped-body reader (`apps/dashboard/src/server/archive/capped-body.ts`) with a cap of a few MB. Keep only `KodeEmiten`, `Sektor`, `SubSektor`, `Industri`, `SubIndustri`, and perhaps `PapanPencatatan` and `Logo` for the logo ticket. Once a day is enough. Any time after the evening archive run works.
2. **Validate.** Drop the whole run, keeping yesterday's table, if `recordsTotal` is far below the stored row count (for example under 90%) or if any sector name falls outside the 11 known names. This guards against an IDX outage page or a schema change wiping the map.
3. **Store.** A `stock_sector` table (`code` primary key, `sector`, `sub_sector`, `industry`, `sub_industry`, `fetched_at`), replaced in one D1 batch. It fits in `HoldingsDb`, or in a new D1 if the spec wants that separate. Around 944 rows: well within limits.
4. **Serve.** One route returns `{ fetchedAt, sectors: { [code]: { sector, industry } } }`. Built from today's response, that is 67 KB raw and 6 KB gzipped, cached at the edge until the next run. The bubble page loads it once and joins it to live codes on the client.

No xlsx parsing is needed, so the hand reader from `origin/research/idx-classification-xlsx-parse` does not apply here.

## Fallback for a code with no sector

A code can reach the bubble map with no usable sector in four ways:

- It listed after the last daily run, or before IDX filled in its profile.
- It is a stale record with a JASICA sector, like `TKGA` and `TMPI`. Validation drops it, so it has no row.
- It is not a stock: a warrant, a rights issue or an ETF, if the live feeds carry those codes.
- The daily run failed for several days, and the table is old but still present.

Recommended fallback:

- Show such a code under one bucket, **Unclassified**, in grey. It appears under All and Top N, and the sector filter offers Unclassified as a twelfth choice, so these codes are never lost.
- Do not look up a single code live from the page. That puts IDX traffic on every viewer and returns JASICA names for the stale records.
- Show the table's `fetchedAt` next to the source credit, so a stale map is visible.

## Open questions

- How many days after a reclassification announcement does `GetCompanyProfiles` change? Diffing the daily table after the next June batch would answer this.
- Do the live feeds carry warrant, rights or ETF codes into the whole-market tape? This decides whether Unclassified stays nearly empty or holds many codes.
- Is Kumora commercial use under IDX's terms? The owner decides.
