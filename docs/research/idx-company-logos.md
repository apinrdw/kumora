# Where company logos can come from, and whether Kumora may show them

Research for [#411](https://github.com/apinrdw/kumora/issues/411), part of the Market Bubbles map [#409](https://github.com/apinrdw/kumora/issues/409). Read on 2026-11-16 from a machine in Indonesia. Nobody signed in to anything. Every coverage number comes from one anonymous request per stock code per source, made that day, against the 944 stock codes in IDX's own company list.

I am not a lawyer. The terms-of-use readings below quote each source's own text. The trademark reading quotes the statute. Neither is legal advice.

## Verdict

**Ship Market Bubbles with code-text-only bubbles, and leave a logo slot that a later ticket can fill from Logo.dev if its IDX coverage measures well.**

- **Stockbit's CDN is the only source that covers the whole market well.** It has all 944 codes as uniform 160 × 160 transparent PNG circles, and it adds new listings before they list. But Stockbit drew those circles itself. Its terms allow personal, non-commercial use only, and they forbid retransmitting content and bulk extraction without written consent. Its CDN also sends no CORS header, so a canvas bubble map could draw the logos only through a Kumora proxy, and a proxy is exactly the copying the terms forbid. Without written permission from Stockbit, this source is not usable.
- **Ajaib** has a code-to-logo list behind sign-in (`/v1/stock/data/company/logo/`). Serving it to members raises the same problem as Stockbit's set (Ajaib's own terms were not read), and it is harder to reach.
- **IDX** lists a logo for every code, but 525 of the 944 files return 404. The ones that exist are mostly old, wide wordmarks on white. IDX's terms forbid scraping, and IDX states that it does not own or license issuers' logos. Not usable.
- **Free logo APIs** (Financial Modeling Prep, EODHD) answer anonymously. But FMP misses 116 codes, including every recent listing, some of its logos are stale, and its terms forbid showing its content to other users without a licence. EODHD covers 271 codes. Neither is usable.
- **Issuer websites** have no common logo path. In a 60-code sample, 45% exposed an `apple-touch-icon`. Scraping 944 sites yields mixed shapes and needs per-code review. Not usable as the main source.
- **Logo.dev** is the only source whose terms fit. Every plan may store logos fetched through its API on Kumora's own storage. Logos look up by domain, and IDX's company list gives a website for 940 of 944 codes. The free plan allows 500,000 CDN requests a month, with attribution only for a commercial project. Its IDX coverage is **unmeasured**: the probe needs a key, and getting a key means signing up.
- **Trademark risk is low for any source.** Indonesia's trademark law makes it an offence to use a registered mark for the same kind of goods or services in trade. A logo that labels a stock code on a market map names the company. It does not sell anything under that mark. The real constraint is the image source's copyright and terms, not trademark.

## Sources

| Tag              | Source                                                                                                                                                                                                                                                                                          | Read       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **[idx-list]**   | `GET https://www.idx.id/primary/ListedCompany/GetCompanyProfiles?emitenType=s&start=0&length=9999`, which returns `recordsTotal: 944` and a `Logo` and `Website` field per code                                                                                                                 | 2026-11-16 |
| **[idx-tou]**    | IDX Terms of Use, `GET https://www.idx.id/primary/page/en/terms-of-use/` (CMS record of `/en/terms-of-use/`)                                                                                                                                                                                    | 2026-11-16 |
| **[sb-bundle]**  | stockbit.com Next.js bundle, `buildId` `v3.56.0`, chunk `61450-0c18e847babf8835.js` and others                                                                                                                                                                                                  | 2026-11-16 |
| **[sb-terms]**   | Stockbit Terms, rendered from `/_next/static/chunks/pages/terms-f4b7890fe61d05de.js` (the page at `https://stockbit.com/terms`)                                                                                                                                                                 | 2026-11-16 |
| **[aj-bundle]**  | Ajaib Trade bundle, entry `index-BZJGQdhq.js`, chunk `useStockIcon-s8xZ4NZu.js`                                                                                                                                                                                                                 | 2026-11-16 |
| **[fmp-tos]**    | [FMP Terms of Service](https://site.financialmodelingprep.com/terms-of-service), "Last updated: August 1, 2023"                                                                                                                                                                                 | 2026-11-16 |
| **[logodev]**    | Logo.dev docs: [ticker](https://www.logo.dev/docs/logo-images/ticker), [self-hosting](https://www.logo.dev/docs/platform/self-hosting), [caching](https://www.logo.dev/docs/platform/caching), [fair use](https://www.logo.dev/docs/platform/fair-use), [pricing](https://www.logo.dev/pricing) | 2026-11-16 |
| **[brandfetch]** | [Brandfetch Logo API guidelines](https://docs.brandfetch.com/logo-api/guidelines)                                                                                                                                                                                                               | 2026-11-16 |
| **[uu-merek]**   | UU No. 20 Tahun 2016 tentang Merek dan Indikasi Geografis, PDF from [peraturan.bpk.go.id](https://peraturan.bpk.go.id/Details/37595/uu-no-20-tahun-2016)                                                                                                                                        | 2026-11-16 |

## Coverage and format

Each row is one `GET` per code for all 944 codes in **[idx-list]**.

| Source                  | URL per code                                                                    | Found                                                                         | Format                                             | Size                                                                 | Last-Modified                                       |
| ----------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| Stockbit                | `https://assets.stockbit.com/logos/companies/{CODE}.png`                        | **944**                                                                       | PNG, RGBA, a filled circle on a transparent square | 160 or 161 px square for 935; median 5.1 KB; 5.1 MB in all           | 738 from 2022, then 75 / 60 / 31 / 40 for 2023–2026 |
| IDX                     | `https://www.idx.id/Portals/0/StaticData/ListedCompanies/LogoEmiten/{CODE}.jpg` | 419 (525 are 404)                                                             | JPEG (2 are PNGs named `.jpg`), mostly on white    | any size: 271 are wider than 1.5 : 1; one is ~99 megapixels (886 KB) | 165 from 2010, a few dozen a year since             |
| Financial Modeling Prep | `https://financialmodelingprep.com/image-stock/{CODE}.JK.png`                   | 828 (116 are 404)                                                             | PNG                                                | 100 × 100 or 128 × 128                                               | not sent                                            |
| EODHD                   | `https://eodhd.com/img/logos/JK/{CODE}.png`                                     | 271                                                                           | PNG                                                | mostly 200 × 200 or 180 × 180                                        | 268 from 2024                                       |
| Ajaib                   | list from `GET ht2.ajaib.co.id/api/v1/stock/data/company/logo/`                 | not probed (sign-in)                                                          | `icon_url` per code on `cdn-stock.ajaib.co.id`     | unknown                                                              | unknown                                             |
| Logo.dev                | `https://img.logo.dev/ticker/{CODE}.JK?token=…`, or the API by domain           | **not measured**                                                              | WebP or PNG, size chosen per request               |                                                                      |                                                     |
| Issuer sites            | none in common                                                                  | 60-code sample: 51 sites answered, 27 had an `apple-touch-icon`, 47 a favicon | mixed                                              | mixed                                                                |                                                     |

What the numbers mean:

- **Stockbit's set is drawn by Stockbit.** Side by side, BBCA is BCA's mark alone in white on a blue circle, while IDX and FMP show the full "BCA" wordmark. Every Stockbit file is the same circle. That makes Stockbit's set the best fit for a bubble, and it also makes it Stockbit's own artwork.
- **Stockbit adds a logo before the listing date.** The six newest listings (RANS, PRDL, BACH, EMMI, JECX, JELI, listed 7–10 July 2026) got their files 15–23 June 2026. A logo exists by the time a code first trades.
- **A few Stockbit files are shared by a group.** BABP, BCAP, BHIT, IPTV and MNCN serve the same MNC image, and DSSA, GEMS and SMMA serve the same Sinar Mas image. There is no generic placeholder: a code with no file gets `403`, and Stockbit's own UI falls back to text (next section).
- **FMP is stale for renamed companies.** ADRO still shows the old Adaro mark, where IDX and Stockbit show AlamTri. FMP misses 13 of the 15 newest listings (all but JELI and EMAS), including AADI, BACH, EMMI, PRDL, RANS, SUPA and WBSA.
- **IDX's set is not maintained as a set.** 56% of codes have no file, 165 of the files that exist date from 2010, and 271 of 419 are wide wordmarks.

## Terms of use

### Stockbit

The bundle builds the URL itself and shows text when the image fails **[sb-bundle]**:

```js
o = "https://assets.stockbit.com/logos/companies"
src: "".concat(o.mM, "/logos/companies/").concat(symbol, ".png"), onError: () => setShowImage(false)
```

The terms say **[sb-terms]**, under "COPYRIGHT AND LIMITATIONS ON USE":

> The content available through Stockbit.com is the property of Stockbit or its licensors and is protected by copyright and other intellectual property laws. … Content received through Stockbit.com may be displayed, reformatted, and printed for your personal, non-commercial use only. You agree not to reproduce, retransmit, distribute, disseminate, sell, publish, broadcast or circulate the content received through Stockbit.com to anyone, … nor any use of data mining, robots, spiders, or similar data gathering and extraction tools for any purpose without the express prior written consent of Stockbit.

What this rules out for Kumora:

- **Copying the set to R2** is bulk extraction and redistribution. It is forbidden without consent.
- **Hotlinking from members' browsers** means no copy is stored, but Kumora still shows Stockbit content to every member, which is not the owner's personal use. It also depends on an undocumented path that Stockbit can block or move at any time.
- **Canvas drawing.** The CDN answers with no `Access-Control-Allow-Origin` header, with or without an `Origin` request header. A `<canvas>` that draws a cross-origin image without CORS becomes tainted, so the map's snapshot button (`toDataURL`) would throw. Getting around that needs a same-origin proxy, which is retransmission.

Kumora already reads Stockbit's websocket through the owner's own signed-in tab (see [stockbit-live-data.md](stockbit-live-data.md)). That is the owner reading their own session. Serving Stockbit's artwork to other members is a different act.

### Ajaib

The bundle fetches `GET /v1/stock/data/company/logo/` on `https://ht2.ajaib.co.id/api/`, keeps a `code → icon_url` map, and caches it for 24 hours (`864e5` ms). A missing icon falls back to `https://cdn-stock.ajaib.co.id/image/PLACEHOLDER_6d8d8234-….png` **[aj-bundle]**. An anonymous request to the list route gets a Cloudflare `403`. The relay extension could capture the list from the owner's tab, but that serves broker content to members in the same way as Stockbit, and it ties a display feature to the relay. Not pursued.

### IDX

**[idx-tou]**:

> Users are prohibited from using or disseminating Information and or data obtained from Website to other parties for commercial purpose without prior written consent from Indonesia Stock Exchange and or the original owner of such Information and or data. The use of Information, including information and or data citation not for commercial purposes is permitted by mentioning the complete source accompanied with the date of Users access citing such information and or data on Website and do not use the web scrapping/crawling method.

> All other trademarks, service marks and logos listed on the Website that are not owned by, licensed or controlled by Indonesia Stock Exchange are only used for editorial needs and without any intention violating such trademarks, service marks and logos.

IDX cannot license issuers' logos, because it says it holds no rights in them. Fetching 944 files is the crawling the terms forbid. Coverage rules IDX out anyway.

The company list itself is still useful. Its `Website` field gives a domain for 940 of 944 codes, which is the key Logo.dev's storage API takes. Using it is a separate question for whoever builds the logo sync, under the same non-commercial clause.

### Financial Modeling Prep

The image route answers anonymously and sends `Access-Control-Allow-Origin: *`. The terms **[fmp-tos]** still forbid the use:

> without the prior written approval of FMP, the Customer may not distribute, publicly perform or display, … copy, create derivative works from … the Services.

The personal licence (2.2.1) adds that the customer may not "integrate the Data or Services into any tools or applications accessible by any third parties, or use the Services to host, share, display, or provide content for others." Showing FMP logos to members needs a commercial plan. With 116 missing codes and stale marks, it is not worth one.

### Brandfetch

Brandfetch takes tickers, but its guidelines **[brandfetch]** require hotlinking ("Logo API images must be hotlinked rather than stored") and forbid proxying or re-hosting. Storing is an Enterprise option. Hotlink-only means the same canvas-taint problem as Stockbit unless the CDN sends CORS headers, and it was not probed because it needs a client id.

### Logo.dev

**[logodev]**:

- Ticker lookups take an exchange suffix, and `.JK` maps to the Indonesia Stock Exchange. The docs do not promise that every symbol resolves.
- "Every plan can self-host the images that the Logo.dev API returns." The storage route is `GET https://api.logo.dev/v2/brands/logo` with a domain and the secret key, server-side. It returns a short-lived download URL and an `etag`. Store the file, not the URL. Re-download when the `etag` changes, or on a `brand.updated` webhook.
- Fair use forbids "a server that fetches `img.logo.dev` images and passes them on to your users" and "bulk scraping of logos for redistribution". So the CDN is for direct `<img>` use, and the API is for stored copies. Logos "remain the property of their trademark owners", to be used "to identify a brand, not to imply endorsement".
- Plans: Community is free with 500,000 CDN requests a month (a hard limit) and needs a visible link to Logo.dev only for a commercial project. Startup is $33 a month and needs no link.

Logo.dev is a licensed path. Its coverage of small Indonesian issuers is the unknown that decides whether it is worth building.

## Trademark

**[uu-merek]** Pasal 1 angka 1 defines a mark as a sign, including a logo, "untuk membedakan barang dan/atau jasa yang diproduksi oleh orang atau badan hukum dalam kegiatan perdagangan barang dan/atau jasa". Pasal 100 ayat (1) punishes whoever "dengan tanpa hak menggunakan Merek yang sama pada keseluruhannya dengan Merek terdaftar milik pihak lain untuk barang dan/atau jasa sejenis yang diproduksi dan/atau diperdagangkan".

A bubble labelled with BBCA's logo identifies the company whose shares traded. Kumora sells no banking service under the BCA mark, so it does not use the mark "untuk barang dan/atau jasa sejenis". The risk that remains is an implied endorsement, which a page that only plots market data does not create. Logo.dev's fair-use rule says the same thing.

Copyright is separate. Whoever made a given image owns it. Stockbit's circles are Stockbit's redraws, and Logo.dev's files come with a storage licence. That is why the source decides the question, not the trademark.

## How Kumora would fetch, cache and serve logos (if a source is adopted)

This design fits Logo.dev's storage API. It also fits any source that later grants written permission.

1. **Sync job.** A Cloudflare Workflow or cron Worker walks the stock codes (the IDX list gives the code-to-domain map), calls the source's API server-side, and writes `logos/{CODE}.webp` (256 px, square) to an R2 bucket with the `etag` in custom metadata. It skips a code whose `etag` has not changed and never overwrites a good file with a failed download. A weekly run is enough: logos change on renames and new listings, and Stockbit's dates show a few dozen changes a year.
2. **Serving.** A dashboard Worker route `GET /logos/{CODE}` streams the R2 object with `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` and its `ETag`. A missing code returns `404` and the bubble shows its code text. Same origin means no canvas taint, so the snapshot keeps working.
3. **Size.** 944 files at about 5–10 KB each is under 10 MB. That is far inside R2's free storage, and a map load that fetches the 100 visible logos costs 100 class-B reads, or none once the browser cache holds them.
4. **Drawing.** Draw a logo only when a bubble's radius passes a threshold (roughly 18 px), and draw code text otherwise. In "All" mode, most of the ~950 bubbles are too small for a logo to be legible, so the logo matters only for the large bubbles of Top 50 / Top 100.

## What would change the verdict

- **Stockbit grants written permission** to store and serve its logo set. Its set is the best fit for bubbles, and the same sync job would apply.
- **A Logo.dev coverage probe.** The owner creates a free Logo.dev key, then requests `img.logo.dev/ticker/{CODE}.JK` (or the API by domain) for the 944 codes and counts real logos against Logo.dev's fallback. If the top 100 codes by value nearly all resolve, adopt Logo.dev with the design above. If they do not, stay with code text.
