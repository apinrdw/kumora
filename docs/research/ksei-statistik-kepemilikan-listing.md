# How KSEI serves the Statistik Efek and Kepemilikan Efek listings and their files

Research for [#319](https://github.com/apinrdw/kumora/issues/319), part of the map [#318](https://github.com/apinrdw/kumora/issues/318). Read on 2026-11-14 (a Saturday) from a machine in Indonesia. Every claim below comes from a live request to KSEI on that date unless it cites another source. Nothing was tested from a Cloudflare Worker; that is [#320](https://github.com/apinrdw/kumora/issues/320).

## Answer

- **Listing endpoint:** both pages read a JSON API that `www.ksei.co.id` proxies at `/api/...`. One call with a large `page[size]` returns the whole listing: `GET https://www.ksei.co.id/api/static_stocks?locale=id&append=pdf_id&page[size]=100` for Statistik Efek and `.../api/securities_ownerships?...` for Kepemilikan Efek. The request must send `Accept: application/json`, or the API answers 405.
- **Pages:** the HTML page shows 8 entries per page and reads its page number from `?page=N` in the page URL. The first page is server-rendered (Nuxt 2), so a plain HTML fetch only shows 8 files.
- **History in the listing:** each listing holds exactly 36 monthly entries, November 2023 to October 2026. It looks like a rolling three-year window (see below).
- **History on the file server:** older files are still served under the same URL pattern but not listed. Files exist at least back to 2008 for Statistik Efek and 2010 for Kepemilikan Efek.
- **Files:** one zip per month per series, named after the **period-end date**: the last trading day of the month. `StatisEfek<YYYYMMDD>.txt.zip` is 122–158 KB, and `BalanceposEfek<YYYYMMDD>.zip` is 104–126 KB. Each zip holds one pipe-delimited `.txt` file.
- **Headers:** `GET` and `HEAD` both return `Content-Length`, `Last-Modified` and an `ETag` that is the MD5 of the bytes. `If-None-Match` and `If-Modified-Since` give 304, and `Range` gives 206.
- **Stability:** no republish was found. Four files have the same SHA-1 today as in Wayback captures from 2023-12 to 2026-02. The URL **path** did change in mid-2026, from `/Download/` to `/storage/Download/`.
- **Bot rules:** there is no Cloudflare and no challenge. The files and the API answer 200 even to curl's default `User-Agent` and to no `User-Agent` at all. There is no `robots.txt`, and no rate limiting was seen. The site's terms cover only the K-CASH app.

## The listing endpoint

### How it was found

The pages are a Nuxt 2 app. The server-rendered HTML inlines `window.__NUXT__`, whose `config` names `BASE_URL: "https://webcms.ksei.co.id/api"`. The page state holds a `pagination` object copied from the API's `meta`, with links such as `https://webcms.ksei.co.id/api/static_stocks?append=pdf_id&filter[published]=true&locale=id&page[size]=8&page[number]=2`. `webcms.ksei.co.id` has no public DNS record (empty answer from 1.1.1.1, 8.8.8.8 and 9.9.9.9). The browser bundle calls the same API by a relative path, so the browser reaches it through `www.ksei.co.id/api/...`. This code is from `/_nuxt/948144cv1410.js`, de-minified:

```js
// Statistik Efek component, method getData
const page = this.$route.query.page || 1;
const append = this.$currentLocale() === "id" ? "pdf_id" : "pdf_en";
await this.$axios.get("/api/static_stocks", { params: {
  locale: this.$currentLocale(),
  search: this.searchKey,              // from ?search=
  "filter[date]": this.filterYear,     // from ?year=
  "page[size]": 8,
  "page[number]": page,
  append,
  "filter[published]": true,
}});
// then: this.pagination = res.data.meta; items mapped to { date, id, name, file: pdf_id || pdf_en }
// watch: "$route.query" -> getData(); onPageChanged pushes ?page=N
```

The Kepemilikan Efek page's server state (`securitiesOwnerships`, with pagination links to `/api/securities_ownerships`) has the same shape. Its component chunk was not among the scripts the Statistik Efek page loads, so it was not read. The endpoint was confirmed by calling it.

### Request and response

```
GET https://www.ksei.co.id/api/static_stocks?append=pdf_id&filter%5Bpublished%5D=true&locale=id&page%5Bsize%5D=100&page%5Bnumber%5D=1
Accept: application/json

HTTP/2 200
server: nginx
content-type: application/json
cache-control: no-cache, private
access-control-allow-origin: *
x-varnish: 16960380
x-cache: MISS
```

```json
{
  "data": [
    {
      "date": "2026-10-30T08:53:12.000000Z",
      "name": "Master File Efek 30 Oktober 2026",
      "pdf_id": [{ "url": "https://www.ksei.co.id/storage/Download/StatisEfek20261030.txt.zip",
                   "filename": "StatisEfek20261030.txt.zip" }]
    },
    ...
  ],
  "links": { "first": "...", "last": "...", "prev": null, "next": null },
  "meta": { "current_page": 1, "from": 1, "last_page": 1, "path": "https://webcms.ksei.co.id/api/static_stocks",
            "per_page": 100, "to": 36, "total": 36, "links": [...] }
}
```

Without `Accept: application/json`, the same URL returns `405 {"code":405,"message":"Backend accept only json communication."}`. A detail path such as `/api/static_stocks/1` returns 404.

### Parameters and paging

| Parameter           | Effect (observed)                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `page[size]`        | Page size. The page sends 8. The default when omitted is 30. `100` and `1000` both return all 36 in one page (`last_page: 1`).                                           |
| `page[number]`      | A 1-based page index.                                                                                                                                                    |
| `filter[date]`      | A year. `2023` returned 2 entries (Nov and Dec 2023), and `2022` returned 0.                                                                                             |
| `search`            | A text filter on `name`. `Juni` returned the three June entries.                                                                                                         |
| `locale` + `append` | `locale=en&append=pdf_en` returns English names ("Master Securities October 30, 2026") with the **same** file URLs. The file key follows `append`: `pdf_id` or `pdf_en`. |
| `filter[published]` | No visible effect: `false` also returned the same 36.                                                                                                                    |

`meta.total` is present, so a client can check it got everything. One call with `page[size]=100` (or more) and no `filter[date]` returns the whole listing.

### Entry shape and quirks

- An entry has only `date`, `name` and `pdf_id` (or `pdf_en`), which is a list with one `{url, filename}`. There is no `id`: the component reads `t.id` and gets `undefined`.
- `date` carries the period-end date, but its **time is the time of the request**. All 36 entries in one response share one time, and that time moved between calls: `08:49:04Z` in the HTML at 08:58 UTC, `08:53:12Z` at 09:02 UTC, then `08:57:22Z` and `08:57:23Z`. This field is not a publication time. Use its date part only, or the date in the filename.
- `name` is "Master File Efek &lt;d Month yyyy&gt;" or "Kepemilikan Efek &lt;d Month yyyy&gt;" in Indonesian.
- Order is newest first.

## Files

### Names, dates and content

- Statistik Efek: `https://www.ksei.co.id/storage/Download/StatisEfek<YYYYMMDD>.txt.zip`, which holds one `StatisEfek<YYYYMMDD>.txt`.
- Kepemilikan Efek: `https://www.ksei.co.id/storage/Download/BalanceposEfek<YYYYMMDD>.zip`, which holds one `Balancepos<YYYYMMDD>.txt`. The inner name has no `Efek`.

`<YYYYMMDD>` is the **period end**: the last trading day of the month, not the calendar month end and not the upload date. Examples: `20251230` (31 Dec 2025 was not a trading day), `20260529`, `20250528`. The first column of every row in both files repeats it (`30-OCT-2026`). Uploads come 1–3 days later (see Cadence).

The two October 2026 files:

| File                         | Zip bytes | Inner file               | Unzipped bytes | Lines |
| ---------------------------- | --------- | ------------------------ | -------------- | ----- |
| `StatisEfek20261030.txt.zip` | 143,181   | `StatisEfek20261030.txt` | 924,811        | 3,654 |
| `BalanceposEfek20261030.zip` | 125,333   | `Balancepos20261030.txt` | 528,033        | 3,734 |

Both are `|`-delimited with a header row. Statistik Efek has one row per security (`Date|Code|Description|Type|Isin Code|Issuer|Status|...`). Kepemilikan Efek has one row per security, with holdings split by local and foreign investor type (`Date|Code|Type|Sec. Num|Price|Local IS|Local CP|...|Foreign OT|Total`). Parsing them is out of scope here.

### Sizes of the 72 listed files

From `HEAD` on every listed URL. All 72 returned 200.

| Series         | Count | Smallest             | Largest              | Total     |
| -------------- | ----- | -------------------- | -------------------- | --------- |
| StatisEfek     | 36    | 122,503 (2023-12-29) | 157,740 (2026-06-30) | 5,115,515 |
| BalanceposEfek | 36    | 104,114 (2023-11-30) | 126,396 (2026-06-30) | 4,169,811 |

That is 9.3 MB in all, with growth of about 270 KB a month for both series together.

### File response

```
GET https://www.ksei.co.id/storage/Download/StatisEfek20261030.txt.zip

HTTP/2 200
server: nginx
content-type: application/zip
content-length: 143181
accept-ranges: bytes
etag: "b16fa4b009aee35b3ea49d8d8af8cc95"
last-modified: Mon, 02 Nov 2026 00:09:49 GMT
vary: Origin
vary: Accept-Encoding
x-amz-id-2: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
x-amz-request-id: 18E7DDD9B01B3E53
access-control-allow-origin: *
```

- `HEAD` returns the same headers as `GET`, including `Content-Length`. There is no `Content-Encoding`, even with `Accept-Encoding: gzip`.
- The `ETag` equals the MD5 of the downloaded bytes, checked on both October files. This is the S3 single-part form. The `x-amz-*` headers show an S3-compatible store behind nginx; `x-amz-id-2` is the SHA-256 of the empty string, which MinIO sends.
- `If-None-Match: <etag>` → 304. `If-Modified-Since` later than `Last-Modified` → 304. `Range: bytes=0-99` → 206 with 100 bytes.
- The listed files are `content-type: application/zip`. The older, unlisted files checked return `application/octet-stream`.
- **A missing file is not a 404.** `/storage/Download/Nonexistent123.zip` and `StatisEfek20190101.txt.zip` return `302 Location: /id`. A fetcher that follows redirects gets the home page HTML with status 200. Treat any 3xx, or a non-zip body, as "not there".

## How far back, and how many

- **Listing:** 36 entries per series, from 2023-11-30 to 2026-10-30. `filter[date]=2022` returns nothing, and `filter[date]=2023` returns only November and December.
- **Server:** files older than the listing are still served. `HEAD` gave 200 for `StatisEfek20231031`, `StatisEfek20221230`, `StatisEfek20181228`, `StatisEfek20121228`, `StatisEfek20101230`, `StatisEfek20081230`, `BalanceposEfek20231031`, `BalanceposEfek20191230`, `BalanceposEfek20181228`, `BalanceposEfek20121228` and `BalanceposEfek20101231`. Every one has `Last-Modified: Fri, 26 Jun 2026 11:22:3x GMT`, the same as every listed file up to May 2026. That points to a bulk copy into this store on 2026-06-26, older files included.
- Not found by guessing Dec 23–31: `BalanceposEfek` for December of 2008 and 2014–2017, and `StatisEfek` for December of 2014–2017. Either the date is outside that range or the file is absent. Before 2009, Kepemilikan Efek files used a different name, `BalanceposEfek<date>.txt.zip` (Wayback, 2015 captures of `BalanceposEfek20080131.txt.zip` to `...20090227.txt.zip`; `.zip` from `20090331`), and that name was not probed here.
- **Unverified:** that the 36-entry listing is a rolling three-year window that drops the oldest month each month. One snapshot cannot show this. It is consistent with `total: 36` in both series while older files exist. Since older files stay on the server, a backfill can construct URLs from trading-day month ends rather than relying on the listing, but there is no index of them, and the 302-on-miss makes probing slow.

## Cadence

Upload time is the file's `Last-Modified`, shown here in WIB (UTC+7). The listing has no publish time.

| Period end       | StatisEfek      | BalanceposEfek  |
| ---------------- | --------------- | --------------- |
| 2026-10-30 (Fri) | Mon 2 Nov 07:09 | Mon 2 Nov 07:08 |
| 2026-09-30 (Wed) | Thu 1 Oct 07:08 | Thu 1 Oct 07:07 |
| 2026-08-31 (Mon) | Tue 1 Sep 07:08 | Tue 1 Sep 07:07 |
| 2026-07-31 (Fri) | Mon 3 Aug 07:09 | Mon 3 Aug 07:07 |
| 2026-06-30 (Tue) | Wed 1 Jul 17:50 | Wed 1 Jul 17:49 |

Since August 2026 both files arrive around 07:07–07:09 WIB on the first calendar weekday after the period end (Saturday and Sunday skipped). That looks like an automated job. The zip's inner timestamp (06:45 and 06:00 WIB on 2 Nov) is earlier. For a schedule, one run on each of the first few days of a month, any time after 08:00 WIB, catches it.

## Stability and republishing

- **Bytes:** for four files, the SHA-1 of today's download (base32) matches the Wayback Machine's digest for an older capture of the same file name:

  | File                         | Wayback capture (old URL)                                                         | Digest                             |
  | ---------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
  | `StatisEfek20231031.txt.zip` | 2023-12-15, `www.ksei.co.id/Download/`                                            | `CLRGPYIWY6HY2NUYLIVFRMTA76WBR3ZV` |
  | `StatisEfek20250131.txt.zip` | 2025-07-15, `www.ksei.co.id/Download/` and 2026-02-06, `web.ksei.co.id/Download/` | `5APLS6RI4PPHQBAWAUDTKYIQ7MGIV5QB` |
  | `BalanceposEfek20251230.zip` | 2026-02-02, `web.ksei.co.id/Download/`                                            | `N7FKS23DCYZPPDL2Z56JBI4UWZ44SLD4` |
  | `StatisEfek20260130.txt.zip` | 2026-02-10, `web.ksei.co.id/Download/`                                            | `75H3WKRP3D363WZ57Y3BMD77ISSYU4ZS` |

  So these four files were not rewritten across the move, one of them for nearly three years. This sample cannot rule out a correction elsewhere.

- **URLs:** the path is not stable over years. Until at least February 2026 the files lived at `https://www.ksei.co.id/Download/<name>` and `https://web.ksei.co.id/Download/<name>`. Today `https://www.ksei.co.id/Download/...` returns 404. `https://web.ksei.co.id/Download/StatisEfek20261030.txt.zip` still returns the same 143,181 bytes from a separate Apache server (`180.92.214.50`), with an Apache-style `ETag` (`"22f4d-65f3f9ff537b4"`) and `Last-Modified: Sun, 01 Nov 2026 23:45:31 GMT`. That host looks like the legacy site, still fed with new files. The file name stayed the same across the move.
- **For the archive:** key each stored object by the period-end date and series, and keep the source URL, `ETag` and `Last-Modified` beside it. A changed `ETag` on a known name is a republish. The name, not the full URL, is the stable identity.

## Bot protection, robots and terms

- `www.ksei.co.id` is nginx with Varnish (`x-varnish`, `x-cache`). There is no Cloudflare, no challenge and no cookie check. `auth.strategy=local` is set but never needed. The files and the API returned 200 with a Chrome `User-Agent`, with curl's default `User-Agent`, and with no `User-Agent` at all.
- `http://` on port 80 timed out (60 s) from here, so use `https://` only.
- `GET /robots.txt` returns `301 → https://www.ksei.co.id/404`. There is no robots file.
- 72 sequential `HEAD` requests, 0.3 s apart, all returned 200. Across about 60 further probe requests, one connection timed out after 30 s, and the next request worked. Nothing looked like throttling (no 429, no `Retry-After`).
- `/id/penafian-umum` is a general disclaimer: KSEI tries to keep the data accurate but takes no responsibility for losses from its use. `/id/ketentuan-dan-kebijakan` holds the K-CASH app terms, privacy policy and security policy, and says nothing about the website's public data or automated access. No terms found restrict fetching these files.
- **Local quirk:** from this machine, resolving `www.ksei.co.id` (a CNAME to `www.wip.ksei.co.id`, `180.92.214.36`) took 15 s every time, while the TLS request itself took about 0.3 s. This is likely a slow AAAA lookup in the local resolver, not KSEI. Do not read the 15 s as server latency.

## Open questions

- **Rolling window:** whether the listing drops November 2023 when November 2026 is added. Re-read `meta.total` and the oldest entry after the next upload (expected Tue 1 Dec 2026).
- **Older history:** the exact set of unlisted files before November 2023, and the pre-2009 naming. Wayback has captures of `/Download/` from 2013–2017 and 2023–2026 (`web.archive.org/cdx/search/cdx?url=ksei.co.id/Download/&matchType=prefix`) that could seed a list.
- **Worker egress:** whether these hosts answer a Cloudflare Worker the same way. That is [#320](https://github.com/apinrdw/kumora/issues/320).

## Sources

- Pages: `https://www.ksei.co.id/id/publikasi/data-dan-statistik/statik-efek` and `.../kepemilikan-efek`, server-rendered `window.__NUXT__` (`config.BASE_URL`, `staticStocks`, `securitiesOwnerships`, `pagination`), 2026-11-14.
- Front-end bundle: `https://www.ksei.co.id/_nuxt/948144cv1410.js`, Statistik Efek component, method `getData`.
- API: `https://www.ksei.co.id/api/static_stocks` and `/api/securities_ownerships`, responses quoted above.
- Files: `HEAD` on all 72 listed URLs, `GET` on six (`StatisEfek20261030`, `BalanceposEfek20261030`, `StatisEfek20250131`, `StatisEfek20231031`, `BalanceposEfek20251230`, `StatisEfek20260130`).
- Wayback Machine CDX: `https://web.archive.org/cdx/search/cdx?url=ksei.co.id/Download/&matchType=prefix&filter=original:.*(Balancepos|StatisEfek).*` and the same for `web.ksei.co.id/Download/`. `ksei.co.id/storage/Download/` has no captures.
- Terms: `https://www.ksei.co.id/id/penafian-umum` and `https://www.ksei.co.id/id/ketentuan-dan-kebijakan`.
