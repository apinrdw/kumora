# How IDX serves the Data Kepemilikan Saham listing and its files

Research for [#296](https://github.com/apinrdw/kumora/issues/296), part of the map [#295](https://github.com/apinrdw/kumora/issues/295). Read on 2026-11-14 (a Saturday) from a machine in Indonesia. Every claim below comes from a live request to IDX on that date unless it cites another source.

## Answer

- **Listing endpoint:** `GET https://www.idx.id/primary/list/id/perusahaan-tercatat/data-kepemilikan-saham/?length=9999` returns the whole listing as JSON in one response: 145 entries, about 28 KB. Each entry has three fields: `Description`, `ListingDate` and `Prospectus` (the file URL). There is no id field.
- **Files:** every file is an `.xlsx` under `https://www.idx.co.id/Media/<8-char id>/<name>.xlsx`. They come in four series: a daily "Pemegang Saham di Atas 5%" file for every trading day, and three month-end files (above 1%, by investor type, by investor classification).
- **History:** the listing starts at 28 November 2025 (investor-type series). The daily series starts at 29 May 2026. The total is 145 files and 56.3 MB.
- **Cadence:** a daily file appears the next calendar day, usually between 10:00 and 15:00 WIB, and after a weekend or holiday on the next working day. The month-end files appear 2 to 5 days after month end.
- **Bot protection:** `www.idx.co.id` sits behind a Cloudflare managed challenge. From this machine, a Chrome `User-Agent` plus any one `Sec-Fetch-*` or `sec-ch-ua*` header passes it. `www.idx.id` serves the same API and the same files with no challenge, even to a bare `curl`. Use `www.idx.id`.

## The listing endpoint

### How it was found

The page is a Nuxt 2 app. Its CMS page record (`GET /primary/page/id/perusahaan-tercatat/data-kepemilikan-saham/`) says the page's `docType` is `prospectusUploader`. The `ProspectusUploader` component in the bundle `/_nuxt/cdbee47.js` loads its table like this (de-minified):

```js
const params = { lang: this.$myLocale(), start: this.page - 1, length: 9999, year: this.selectedYear };
await this.$axios.get("/primary/list" + this.$route.path, { params });
// then: this.tableData = response.data.items
```

`selectedYear` defaults to the current year, and the year dropdown offers only the last five years. The server-rendered HTML also inlines the current year's items in `window.__NUXT__`.

### Request and response

```
GET https://www.idx.id/primary/list/id/perusahaan-tercatat/data-kepemilikan-saham/?lang=id&start=0&length=9999

HTTP/2 200
content-type: application/json; charset=utf-8
cache-control: public, max-age=300
server: cloudflare
x-served-by: app1
set-cookie: __cf_bm=...; Domain=idx.id; ...
set-cookie: EGRUM_BTM=...; path=/; secure
```

```json
{
  "items": [
    {
      "Description": "Pemegang Saham di Atas 5% per 12 November 2026",
      "Prospectus": "https://www.idx.co.id/Media/ioafkqwf/peng-2026-11-12-00116-lima-persen.xlsx",
      "ListingDate": "2026-11-12T12:00:00"
    },
    ...
  ],
  "meta": { "startIndex": 0, "pageSize": 9999, "pageTotal": 1, "search": "" }
}
```

The English page uses its own path and returns the same 145 file URLs with English descriptions ("Share Ownership Above 5% as of November 12, 2026"):

```
GET https://www.idx.id/primary/list/en/listed-companies/share-ownership-data-of-listed-companies/?length=9999
```

The English path comes from the page record's `i18n.links.en`. The guessed path `/primary/list/en/listed-companies/shareholding-data/` returned 503.

### Parameters and paging

| Parameter | Effect (observed) |
|---|---|
| `year` | Filters by `ListingDate` year. `2026` gave 143 items, `2025` gave 2, and 2010–2024 and 2027 each gave `{"items":[],...}`. Omitting it returns every year: 145 items. |
| `length` | Page size. The default is 25 when omitted (`pageSize: 25, pageTotal: 6`). |
| `start` | A zero-based **item** offset, not a page index. `start=1&length=3` returns items 2–4. |
| `search` | A server-side text filter. `search=satu` returned only the "above 1%" files, so it also matches the file URL. |
| `lang` | Has no effect on this path: `lang=en` on the Indonesian path still returns Indonesian descriptions. The path picks the language. |

`meta` has no total count, only `pageTotal = ceil(total / length)`. Sending `length=9999` with no `year` gets the whole history in one call, so no paging is needed.

Items are sorted by `ListingDate`, newest first. Within one date the order is not stable: the Indonesian and English responses order the four month-end files differently.

### Entry shape and quirks

- `Description` is free text typed by an editor. Ten of the 145 have trailing spaces or a trailing `\n` (for example `"...per 31 Maret 2026  \n"`). Trim it before use.
- `ListingDate` is the **data date** (the "per" date in the description), always at `T12:00:00` with no time zone. It is not the publish time. For the publish time, use the file's `Last-Modified` header (see Cadence).
- `Prospectus` is always an absolute `https://www.idx.co.id/Media/...` URL, even when the API is called on `www.idx.id`.
- There is no id field. The file URL is unique across all 145 entries, and so is `Description`.
- Four entries share each month-end date, for example on `2026-10-30`: the daily 5% file plus the three monthly files.

## Files

### Types and series

All 145 files are `.xlsx` (`content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`; `file` reports "Microsoft Excel 2007+"). The page's disclaimer (CMS field `disclaimer`) names the four series and says the data comes from KSEI (PT Kustodian Sentral Efek Indonesia):

| Series (`Description` prefix) | Cadence | Count | First data date | Size |
|---|---|---|---|---|
| Pemegang Saham di Atas 5% | every trading day | 116 | 2026-05-29 | 386–405 KB |
| Pemegang Saham di Atas 1% | month end | 9 | 2026-02-27 | 562–626 KB |
| Data Kepemilikan Saham Perusahaan Tercatat per Tipe Investor | month end | 12 | 2025-11-28 | 172–269 KB |
| Data Kepemilikan Saham Perusahaan Tercatat Berdasarkan Klasifikasi Investor | month end | 8 | 2026-03-31 | 260–393 KB |

The daily series has no gaps. Its 116 dates are exactly the weekdays from 2026-05-29 to 2026-11-12, minus the 2026 exchange holidays (1 Jun, 16 Jun, 17 Aug, 25 Aug) from [`docs/research/idx-trading-schedule.md`](https://github.com/apinrdw/kumora/blob/research/idx-trading-schedule/docs/research/idx-trading-schedule.md).

### URL and name structure

`https://www.idx.co.id/Media/<id>/<name>.xlsx`

- `<id>` is 8 random lowercase letters and digits (`ioafkqwf`, `2ygosvbp`). Changing it gives a 404. Paths are case-insensitive: `/media/...` also returns 200.
- `<name>` is typed by hand and follows no single pattern:
  - daily: `peng-YYYY-MM-DD-NNNNN-lima-persen` (`NNNNN` counts up from `00001` on 2026-05-29 to `00116`),
  - monthly since July 2026: `peng-YYYY-MM-NNNNN-{satu-persen|tipe|klasifikasi}`, with one counter shared across the three monthly series (`00018`–`00029`),
  - monthly before July 2026: `peng-MM-NNNNN-...` with no year, and two files share a number (`peng-06-00015-satu-persen.xlsx` and `peng-06-00015-klasifikasi.xlsx`).

Do not parse meaning out of the name. Take the data date from `ListingDate` and the series from the `Description` prefix.

### Do the names stay stable across republishes?

This research found no republish to observe, so this is not settled.

- The only historical copy found is one Wayback Machine capture, from 2026-11-06, of `Media/yqjhhsee/peng-2026-09-00024-satu-persen.xlsx`. Its digest (`MMN456GLUAOZ23W4TKVR7CVJDY3BII4V`, SHA-1 in base32) matches the bytes served today. That shows the bytes and URL were stable for 8 days for one file, and nothing more.
- `Last-Modified` shows files uploaded in batches long after their data date. On 2026-06-03, every monthly file from November 2025 to April 2026 was uploaded. On 2026-07-28, the 27 daily files from 29 May to 7 July were uploaded. On 2026-10-02, the July and August monthly files were uploaded along with September's. These batches could be first uploads (the page launching, or a backlog) or replacements. Without earlier captures there is no way to tell.
- The `ETag` (for example `"03a76c15973dd1:0"`) is the IIS form, built from the file's modification time. It changes when a file is replaced in place.

For the archive, this means: key each stored object by a hash of its bytes, record the source URL, `ETag` and `Last-Modified` beside it, and treat a changed `ETag` on a known URL as a possible new version. A replaced file under a new `<id>` would show up as a new URL that shares a `Description` with an old one.

### File response

```
GET https://www.idx.id/Media/ioafkqwf/peng-2026-11-12-00116-lima-persen.xlsx

HTTP/2 200
content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
accept-ranges: bytes
cache-control: public, max-age=14400
etag: "03a76c15973dd1:0"
last-modified: Fri, 13 Nov 2026 10:28:42 GMT
cf-cache-status: REVALIDATED
```

That `GET` carried no `Content-Length`. The same file on `www.idx.co.id` sent `content-length: 400184`. `HEAD` on `www.idx.id` works and returns `Content-Length`, `ETag` and `Last-Modified`. `Range` works (`-r 0-99` returned 206 with 100 bytes). `www.idx.id/Media/...` and `www.idx.co.id/Media/...` returned byte-identical files (same SHA-256, `7f848144...b81b9b3`).

## How far back, and how many

- The oldest entry has data date 2025-11-28 (`peng-11-00004-tipe.xlsx`). `year=2024` and earlier return nothing, so the endpoint has no older data.
- There are 145 entries in total on 2026-11-14, adding up to 56,329,022 bytes. All 145 files answered `HEAD` with 200 on `www.idx.id`.
- Growth is about 21 daily files (≈8.4 MB) plus 3 monthly files (≈1.2 MB) a month, so about 10 MB a month.
- The Wayback Machine has no capture of the page, either language, or the `/primary/list/...` endpoint. CDX queries for those URLs returned empty results. The archive was also briefly "Temporarily Offline" during this research. So whether IDX once listed files older than November 2025 and later removed them cannot be checked.

## Cadence

The table below measures the time from the data date to `Last-Modified`, in WIB. It leaves out the batch uploads listed above.

| Series | Typical lag | Upload hour (WIB) |
|---|---|---|
| 5% daily | next calendar day (69 of 116). Friday data comes on Monday (3 days). Data before a holiday comes 2–4 days later. | mostly 10:00–15:00; a few at 16:00–17:00, one at 08:00, one at 21:00 and one at 23:00 |
| Monthly ×3 | 2–5 days after month end, all three on the same day | September: 2 Oct 13:52–13:53; October: 2 Nov 14:53–21:31 |

Examples: the 12 November file was uploaded at 2026-11-13 17:28 WIB, and the 11 November file at 2026-11-12 13:46 WIB. On Saturday 2026-11-14 the newest entry was still 12 November, so the 13 November (Friday) file is expected on Monday.

For the schedule: one run each evening (around 20:00 WIB, 13:00 UTC) catches the same-day upload in most cases. A late upload is picked up the next evening, because each run diffs the full listing rather than only the newest entry.

## Bot protection

### `www.idx.co.id`: Cloudflare managed challenge

The page, the `/primary/...` API, the `/Media/...` files and even `/robots.txt` all sit behind it. A blocked request looks like this:

```
GET https://www.idx.co.id/id/perusahaan-tercatat/data-kepemilikan-saham/
User-Agent: Mozilla/5.0 (X11; Linux x86_64) ... Chrome/130.0 Safari/537.36

HTTP/2 403
content-type: text/html; charset=UTF-8
cf-mitigated: challenge
server: cloudflare
critical-ch: Sec-CH-UA-Bitness, Sec-CH-UA-Arch, ... Sec-CH-UA, UA-...
set-cookie: __cf_bm=...; Domain=idx.co.id
```

The body is the JavaScript challenge page (`challenges.cloudflare.com`). Results of each attempt from this machine, the same for the API, a `/Media/` file and the HTML page:

| Headers sent | Status |
|---|---|
| Chrome UA only | 403 |
| Chrome UA + `Accept` (json or html) | 403 |
| Chrome UA + `Accept-Language` | 403 |
| Chrome UA + `Referer: https://www.idx.co.id/` | 403 |
| Chrome UA + `Accept` + `Accept-Language` + `Referer` | 403 |
| curl's default UA + `Accept` + `Accept-Language` + `Referer` | 403 |
| Chrome UA + **any one** of `Sec-Fetch-Mode`, `Sec-Fetch-Site`, `Sec-Fetch-Dest`, `sec-ch-ua`, `sec-ch-ua-mobile` | **200** |
| curl's default UA + any one of those headers | 403 |

So, from this IP on this date, the rule needed a browser `User-Agent` plus at least one header that only browsers send. No cookie and no solved challenge were needed. This is a Cloudflare bot-management heuristic, not a documented contract. It can tighten at any time, and requests from a Cloudflare Worker's egress were not tested.

### `www.idx.id`: no challenge

`www.idx.id` is the same Nuxt app and the same origin (`x-served-by: app1` on both). It serves the page, `/primary/...` and `/Media/...` with 200, even to curl's default `User-Agent` or with no `User-Agent` header at all. It sets `__cf_bm` and `EGRUM_BTM` cookies, but no request needed them back. `http://` redirects to `https://` with a 301. 145 sequential `HEAD` requests, 0.3 s apart, all returned 200 with no rate limiting. The earlier IDX research ([#56](https://github.com/apinrdw/kumora/issues/56), `docs/research/idx-trading-schedule.md` on `research/idx-trading-schedule`) saw the same split between the two hosts on 2026-11-06.

**Recommendation:** read the listing from `www.idx.id/primary/list/...`, and rewrite each `Prospectus` URL from `https://www.idx.co.id/` to `https://www.idx.id/` before downloading. Keep the original `Prospectus` URL in the metadata JSON. If `www.idx.id` starts to challenge, the fallback is `www.idx.co.id` with a Chrome UA plus `Sec-Fetch-Mode: navigate`. That fallback was not tested from a Worker.

## Open questions

- **Republish behaviour:** whether a corrected file keeps its URL (with a new `ETag`) or gets a new `<id>`. No republish was observed. The archive design above handles both cases.
- **Worker egress:** whether `www.idx.id` and the `idx.co.id` header trick still work from Cloudflare Workers' outbound IPs. Test this from a preview stage before relying on it.
- **Older history:** whether files from before November 2025 were ever listed and then removed. Wayback has no captures that could answer this.

## Sources

- Live responses from `www.idx.id` and `www.idx.co.id`, 2026-11-14, as quoted above.
- Page record: `https://www.idx.id/primary/page/id/perusahaan-tercatat/data-kepemilikan-saham/` (`docType`, `i18n.links`, `disclaimer`).
- Front-end bundle: `https://www.idx.id/_nuxt/cdbee47.js`, component `ProspectusUploader`, method `getDataTable`.
- Wayback Machine CDX API: `https://web.archive.org/cdx/search/cdx?url=idx.co.id/Media/&matchType=prefix&filter=original:.*(persen|tipe|klasifikasi).*` (one capture), plus empty results for the page and the API paths.
