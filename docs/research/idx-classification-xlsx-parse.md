# Parsing an IDX classification xlsx inside the dashboard Worker

Research for [#351](https://github.com/apinrdw/kumora/issues/351), part of the map [#350](https://github.com/apinrdw/kumora/issues/350). Run on 2026-11-15. Every timing below comes from a throwaway Worker run locally under `wrangler dev` (wrangler 4.155.0, workerd pinned to `1.20261026.1`, the version in this repo's `pnpm-lock.yaml`), with `compatibility_date = "2026-11-02"` and `nodejs_compat`, the dashboard's settings (`packages/deploy/src/target.ts`, `packages/deploy/src/stack.ts`). The machine is an Intel i5-13400. Claims that come from Node or from documentation say so.

## Answer

- **Recommendation: read the two XML parts by hand, with no dependency.** Locate `xl/sharedStrings.xml` and `xl/worksheets/sheet1.xml` through the zip's central directory, inflate them with the Web-standard `DecompressionStream("deflate-raw")`, and scan them with three regexes (row, cell, value). About 100 lines of code (sketch below), **2.3 KiB** added to the bundle, **11–12 ms** per Mar/May file and **18–19 ms** per Sep/Oct file on workerd. Its output matches SheetJS cell for cell on every data cell of the four files.
- **If the owner prefers a library: SheetJS 0.20.3 from `cdn.sheetjs.com`.** It runs on workerd, adds **380 KiB** (130 KiB gzip), and takes **60 ms** (Mar/May) to **107 ms** (Sep/Oct). Apache-2.0. Use the CDN tarball. npm's `xlsx` stops at 0.18.5 (2022-03-24), which both SheetJS CVEs affect.
- **fflate plus the same hand reader** also works (**6.9 KiB** added, **16 ms** / **25 ms**). It is the fallback if `DecompressionStream` ever misbehaves. It is slower than the native inflate here.
- **Ruled out:**
  - **exceljs 4.4.0** parses the first request in an isolate, then **hangs every later request** in the same isolate ("code had hung and would never generate a response"). It also adds 937 KiB, and its last release was 2023-10-19.
  - **read-excel-file 9.3.17 (`/universal`)** throws `ReferenceError: Worker is not defined` on all four files. Its unzip calls fflate's async `unzip`, which spawns a Web Worker for any entry over 512 KB uncompressed. Every `sheet1.xml` here is 1.4–2.6 MB.
- **Limits:** every option that works fits Workers Paid's 30 s default CPU limit and the 128 MB isolate memory with large margins. None reliably fits the Free plan's 10 ms CPU limit, not even the hand reader. The bundle limit is 64 MiB uncompressed, so even SheetJS is not a size problem ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **No DOM XML parser on workerd.** `typeof DOMParser` is `"undefined"` in the test Worker. `DecompressionStream` and `HTMLRewriter` are functions. SheetJS carries its own zip and XML code, so it doesn't need one. The hand reader doesn't need one either.

## The files

Downloaded from `www.idx.id/Media/...` on 2026-11-15. Each is a zip with one worksheet, `xl/worksheets/sheet1.xml` (`unzip -l`).

| File | Bytes | `sheet1.xml` (deflated → raw) | `sharedStrings.xml` raw | `<dimension>` |
| --- | --- | --- | --- | --- |
| `peng-03-00001-klasifikasi.xlsx` (Mar) | 270,653 | 226,400 → 1,410,129 | 61,314 | `A1:AQ962` |
| `peng-05-00003-klasifikasi.xlsx` (May) | 273,696 | 231,097 → 1,433,862 | 61,397 | `A1:AR965` |
| `peng-2026-09-00026-klasifikasi.xlsx` (Sep) | 388,660 | 355,564 → 2,593,639 | 63,639 | `A1:CD966` |
| `peng-2026-10-00028-klasifikasi.xlsx` (Oct) | 392,917 | 358,572 → 2,614,650 | 63,642 | `A1:CD966` |

What the XML holds (read with `unzip -p` and `grep`):

- **Cell types:** only shared strings (`t="s"`, 1,958–2,009 a file) and plain numbers. No inline strings, no `t="str"`, no formulas (`<f>`).
- **Dates:** column A is a number with a date style, for example `<c r="A5" s="1"><v>46325</v></c>`. `Date.UTC(1899, 11, 30) + 46325 × 86 400 000` is 2026-10-30, and 46171 is 2026-05-29 (Node).
- **Shared strings:** some use rich-text runs (`<si><r><t>*</t></r><r><rPr>…</rPr><t>Penafian:</t></r>…`, the disclaimer in row 1), so a reader must join every `<t>` in an `<si>`. Each file has 3 `&amp;` entities and no others.
- **Merged cells:** title rows only: `A1:K1`, `A3:AQ3`, `A5:AQ5` (Mar, May) and `A1:K1`, `A2:CD2`, `A3:CD3` (Sep, Oct). No merge touches the header or the data.
- **May's trailing column:** every row carries a styled cell with no value, `<c r="AR7" s="10"/>`, and the rows declare `spans="1:44"` against 43 real columns. Mar has no such cell.
- **The Sep/Oct layout keeps `DATE` and `ISSUER_NAME`:** the header row (row 4) starts `DATE, SHARE_CODE, ISSUER_NAME, Local_Bank, Local_Government…` across 82 columns (A–CD). The first data row is row 5.

## Results on workerd

Each Worker took the xlsx as a POST body and parsed it 10 times in one request. The table shows the median of the 10 runs. Locally, `performance.now()` advances during CPU work: a 5×10⁷ loop read 25 ms in the test Worker, and Cloudflare documents that local timers advance while deployed ones only move after I/O ([Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)). These are local wall times, so they show CPU time on this machine, not on Cloudflare's hardware. workerd reports whole milliseconds.

| Reader | Added bundle (minified) | Mar | May | Sep | Oct | Later requests in the same isolate |
| --- | --- | --- | --- | --- | --- | --- |
| Hand reader + `DecompressionStream` | 2.3 KiB (3,870 B total − 1,544 B harness) | 12 ms | 11 ms | 19 ms | 18 ms | OK |
| Hand reader + fflate 0.8.3 `unzipSync` | 6.9 KiB | 17 ms | 16 ms | 26 ms | 26 ms | OK |
| SheetJS 0.20.3 (`XLSX.read`, dense) | 380 KiB (130 KiB gzip) | 63 ms | 60 ms | 107 ms | 108 ms | OK |
| exceljs 4.4.0 | 937 KiB (270 KiB gzip) | 99 ms (first request) | 108 ms (first request, fresh isolate) | hung | hung | **Hangs** |
| read-excel-file 9.3.17 `/universal` | 54 KiB (17 KiB gzip) | throws | throws | throws | throws | n/a |

The first run in a request was often slower than the rest (for example SheetJS Mar: 81 ms, then 59–67 ms). Bundle sizes are `wrangler deploy --dry-run --minify` "Total Upload" for each test Worker, minus the 1.51 KiB harness-only Worker.

**Correctness.** Each Worker hashed its grid after it trimmed trailing nulls. The two hand readers produced identical SHA-256 digests on all four files. In Node, a cell-by-cell diff of the hand reader against SheetJS found **one** differing cell per file: the row-1 disclaimer, where the XML has `\r\n` and SheetJS returns `\n`. Every header and data cell matched. exceljs's digest differs because it copies merged values (below).

**exceljs hang.** On a fresh `wrangler dev`, three parses inside the first request succeeded (147, 108, 102 ms). The next request, with the same file, failed with "The Workers runtime canceled this request because it detected that your Worker's code had hung". Every request after that failed in 3–11 ms. That pattern usually means a promise or I/O object was created in one request's context and awaited in another. Its dependency tree includes `jszip`, `lie`, `immediate` and `setimmediate`, but the exact cause was not traced. A deployed Worker reuses isolates across requests, so this rules exceljs out.

**read-excel-file failure.** Stack: `fflate/esm/browser.js` `wk` → `inflate` → `unzip` ← `read-excel-file/modules/zip/unzipFromArrayBuffer.js`. fflate's `unzip` inflates synchronously only when `su < 524288 || sc > 0.8 * su` (`fflate/esm/browser.js`, around line 2620). Otherwise it calls `inflate`, which starts a Web Worker, and workerd has no `Worker` global.

**Memory (Node 26 fallback, not workerd).** Heap growth during one parse: hand + `DecompressionStream` 6.5 MB (May) and 8.0 MB (Oct); hand + fflate 3.1 / 4.8 MB; SheetJS 10.8 / 12.7 MB. These are rough heap-only numbers (`process.memoryUsage().heapUsed`), but they are an order of magnitude below the 128 MB isolate limit.

## Empty trailing cells and merged cells

| Reader | May row 7 (has `<c r="AR7" s="10"/>`) | May header row 5 | Merged title cells |
| --- | --- | --- | --- |
| Hand reader | length 44, last is `null` | length 43 | value only in the top-left cell (what the XML stores); `<mergeCells>` ignored |
| SheetJS (`header: 1, defval: null`) | length 44, last is `null` | length 44: pads every row to `!ref` | value only in the top-left cell; ranges in `ws["!merges"]` |
| exceljs | length 43: drops the valueless cell | length 43 | **copies** the top-left value into every merged cell (row 5's last three cells all read "NUMBER OF SCRIPLESS SHARES BASED ON INVESTOR TYPE AND CLASSIFICATION") |

Either way, a parser should **find the header row by its labels and read columns by header position, ignoring anything past the last labelled column**. Then May's extra column, whether it reads as `null` or is missing, can't shift or add a classification.

## Hand reader sketch

This is what ran in the test Worker (types trimmed). It assumes the one-sheet structure above. A production version should resolve the sheet path through `xl/workbook.xml` and `xl/_rels/workbook.xml.rels` rather than hard-coding `sheet1.xml`, and fail loudly on an entry that isn't stored (0) or deflated (8).

```ts
// zip: End of Central Directory → central directory → local header → data
const entries = (u8: Uint8Array) => {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let eocd = u8.length - 22
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--
  let p = dv.getUint32(eocd + 16, true)
  const out = new Map<string, { method: number; size: number; offset: number }>()
  for (let i = 0, n = dv.getUint16(eocd + 10, true); i < n; i++) {
    const nameLen = dv.getUint16(p + 28, true)
    const local = dv.getUint32(p + 42, true)
    out.set(new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)), {
      method: dv.getUint16(p + 10, true),
      size: dv.getUint32(p + 20, true),
      offset: local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true),
    })
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true)
  }
  return out
}
const inflate = (raw: Uint8Array) =>
  new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text()

// sharedStrings: join every <t> inside each <si> (rich-text runs), then decode entities
const si = /<si>([\s\S]*?)<\/si>/g, t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
// sheet: rows (self-closing or not), cells (self-closing or not), then <v>
const rowRe = /<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g
const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
// per cell: column from r="AB12", t="s" → sst[Number(v)], no t → Number(v), no <v> → null
```

The entity decoder handles `&amp; &lt; &gt; &quot; &apos;` and numeric references. The zip reader trusts the central directory sizes, so data descriptors (bit 3) don't matter. ZIP64 isn't handled and isn't needed at these sizes.

## Library facts

| | Licence | Version tested | Where from | Notes |
| --- | --- | --- | --- | --- |
| SheetJS CE | Apache-2.0 (`package.json`) | 0.20.3, the newest in `https://cdn.sheetjs.com/xlsx.lst` | `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` | [CVE-2023-30533](https://cdn.sheetjs.com/advisories/CVE-2023-30533) affects ≤ 0.19.2 and [CVE-2024-22363](https://cdn.sheetjs.com/advisories/CVE-2024-22363) affects ≤ 0.20.1 ("upgrade to version 0.20.2 or later"). Both pages list npm's `xlsx` as affected, and npm's latest is 0.18.5. |
| exceljs | MIT | 4.4.0 (2023-10-19; a 4.4.1 prerelease, 2024-12-20) | npm | `main` is the Node build. It bundled under `nodejs_compat` without errors. |
| read-excel-file | MIT | 9.3.17 | npm | Depends on `fflate`, `saxen`, `unzipper-esm`, `worker-f`. |
| fflate | MIT | 0.8.3 | npm | `exports` resolves the browser build (`esm/browser.js`) under wrangler's conditions. `unzipSync` works. `unzip` (async) needs `Worker` above 512 KB. |

## Open questions

- **Deployed CPU time.** The numbers are local workerd times. On a preview stage, Workers Logs' invocation CPU time would confirm them ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), "CPU time and wall time appear in the invocation log"). At 20 ms against a 30 s default, this only matters on the Free plan.
- **The other four archived files** (Apr, Jun, Jul, Aug 2026) were not run. They share the Mar/May layout per the map, and the reader doesn't depend on row count.

## Sources

- Live runs on 2026-11-15: four test Workers under `wrangler dev` (workerd `1.20261026.1`), as described above. The bench code was a throwaway in a scratch directory and is not committed.
- Files: `https://www.idx.id/Media/onug1zbx/peng-03-00001-klasifikasi.xlsx`, `https://www.idx.id/Media/shaercn0/peng-05-00003-klasifikasi.xlsx`, `https://www.idx.id/Media/yyhm1ha5/peng-2026-09-00026-klasifikasi.xlsx`, `https://www.idx.id/Media/5dxpntd5/peng-2026-10-00028-klasifikasi.xlsx`.
- Cloudflare: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (CPU 10 ms Free, 30 s default and 5 min max Paid; 128 MB per isolate; 64 MiB uncompressed size, "There is no compressed size limit"), [Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/), [Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/) ("`CompressionStream` and `DecompressionStream` … support the deflate, deflate-raw and gzip compression methods").
- SheetJS: `https://cdn.sheetjs.com/xlsx.lst` and the two advisory pages linked above.
- Package sources: `fflate/esm/browser.js` (`unzip`), `read-excel-file/modules/zip/unzipFromArrayBuffer.js`, `read-excel-file/modules/export/readXlsxFileUniversal.js`. Release dates and licences come from `npm view`.
