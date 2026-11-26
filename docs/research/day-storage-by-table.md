# Day storage by table: where a trading day's 1.3–1.8 GB goes

Research ticket [apinrdw/kumora#546](https://github.com/apinrdw/kumora/issues/546), part of the map [apinrdw/kumora#529](https://github.com/apinrdw/kumora/issues/529). Written 2026-11-18 against `origin/staging` at `4b8a6ceb7d`.

**Question.** Production's `TradingDay` namespace grows 1.3–1.8 GB each trading day (4.40 → 6.17 → 7.44 GB, 2026-11-16 to 11-18, [#532](https://github.com/apinrdw/kumora/issues/532)). The cost runbook expected about 0.1–0.15 GB. Which tables hold it?

**Short answer.** The **heatmaps** table, with **book chunks** after it. The runbook priced both for **30 codes** with books (`docs/runbooks/order-flow-cost.md`, "Codes with books, K: 30; upper bound 100"). The extension subscribes Stockbit's `order_book` for **every code in the code list**, and the object records a chunk and a heatmap row for every code whose served book changed in a minute. So K is the whole market, about 700–900 codes. On the model day, each code-minute with a book frame costs about **6.0 KB on disk**: 4.7 KB for the heatmap row and 1.3 KB for the gzipped chunk. The heatmap row is plain JSON of about 3.1 KB. That is over SQLite's ~1 KB in-page limit for a `WITHOUT ROWID` row, so every row also takes a 4 KiB overflow page of its own. With books for 30 codes, the model day is **627 MB**. With books for 900 codes, it is **2,027 MB**, and heatmaps alone are 1,149 MB. The measured 1.3–1.8 GB falls between the two. It matches about 125 K–210 K book code-minutes a day, which is 460–770 codes at 273 minutes each. Second and third are **sweep brokers** (237 MB) and the **broker trades index** (96 MB). Both are written by the evening broker codes walk, and both sit at 44–51 % page fill. Free pages are not the cause: the day's `INSERT OR REPLACE` and delete churn left 1 free page, and `databaseSize` leaves the freelist out anyway.

## Sources and method

- **Code read**: `apps/dashboard/src/server/market-live/` (`day-store.ts`, `broker-codes.ts`, `sweep-brokers.ts`, `trading-day.ts`, `book-chunks.ts`, `heat-rows.ts`, `footprint-cells.ts`, `sweep-rows.ts`, `order-books.ts`, `on-demand.ts`, `trading-day-object.ts`), `apps/dashboard/src/lib/heatmap.ts`, `packages/relay/src/{recorded-day,order-book,sweeps,envelope}.ts`, and the extension's `apps/extension/src/worker/{stockbit,subscriptions,service-worker}.ts`.
- **The model**: `day-storage.mjs` ([appendix](#appendix-the-scripts)). It extends the audit's model day (`docs/research/do-sql-audit.md` on `research/do-sql-audit`, [#531](https://github.com/apinrdw/kumora/issues/531)). It reads the `SCHEMA` literals out of `day-store.ts`, `broker-codes.ts` and `sweep-brokers.ts` and builds the day in Node 26's `node:sqlite` (SQLite 3.54.1, 4 KiB pages, the same page size as workerd; dbstat is compiled in). It writes in the object's order, with payloads built the way the encoders build them:
  - **Live hours**: one transaction a minute, as `armFlush` does (`trading-day.ts:848`). Each holds the minute's trades, then the settled minute's candles and footprints, then a late `INSERT OR REPLACE` of half of the minute before (r = 1.5, the runbook's figure). It also holds the closed book chunks and their heatmap rows, all 910 live prices, 30 Ajaib books and the `feed-downs` fact.
  - **Trades**: 1.46 M of them (Production's busiest day, #258). Numbers run in time order, minutes are weighted to the open and close, and codes are Zipf (s = 0.9) over 900 stocks. Prices move by IDX ticks, lots are geometric (mean 40, 2 % ×50), 97 % trade on RG, and `feeds` is `Ajaib,Stockbit`.
  - **Footprints**: the `cellsText` and `sweepsText` JSON, built from each code-minute's RG trades by the `sweepsOf` rule (same side and same second). Sides persist with p = 0.75, which gives **0.74 sweeps a trade**. The runbook assumed 0.3.
  - **Books**: 20 levels a side. A code at rank r sends 120 / (1 + r/10) frames a minute: 120 for the busiest code (about the 33 K a day `heatmap.ts` measured), and about 1.3 for rank 900. A code below 1 frame a minute has a chunk in that share of its minutes. Each frame changes 1–3 levels on one side or both, and 3 % of frames move the book a tick. A chunk is the `BookChunk` JSON (a start book plus every delta), gzipped like `day-store.ts:488`. The heatmap row comes from those frames by `heatSlices`' weighting and `slicesText`'s JSON.
  - **Evening**: Ajaib's broker codes walk runs newest first, in 1,830-trade batches (~820 a day, #531). Each batch replaces its 7,000-byte `broker_code_chunks` records, inserts 2 `broker_trades` rows a trade, and recomputes the `sweep_brokers` rows of the minutes it touched. A row is written only when its text changed, so the walk wrote 450 K rows for 223 K code-minutes. Then Stockbit's cross-check runs forward in 1,000-trade batches. It replaces every chunk again and records a difference for 0.07 % of trades.
- **Measured**: `dbstat` bytes, payload, overflow pages and fill for each B-tree, plus `page_count` and `freelist_count`. This is measured after the seal, after Ajaib's walk, after Stockbit's cross-check, and after a `VACUUM` (K = 30 only; the K = 900 database did not fit twice on the scratch disk). The tables have no secondary indexes. Every table is one B-tree (its primary key), so the rows below cover every index.
- **Not used**: Production's recorded data. Reading it needs the owner's session cookie (`docs/agents/production-reads.md`), and this ticket could not ask for it. [What is unconfirmed](#what-is-unconfirmed) lists the figures it would refine.

## Bytes by table, the model day

After Ajaib's walk and Stockbit's cross-check, before any `VACUUM`. The first column is K = 900 (every code books). The second is the runbook's K = 30. Everything except the two book tables is the same in both.

| Rank | B-tree                                                                            | K = 900, MB | K = 30, MB |            Rows |             Disk bytes a row | Payload bytes a row |     Fill | Overflow pages |
| ---: | --------------------------------------------------------------------------------- | ----------: | ---------: | --------------: | ---------------------------: | ------------------: | -------: | -------------: |
|    1 | `heatmaps`                                                                        | **1,149.2** |       38.3 | 245,700 / 8,190 |                        4,677 |               3,148 |     67 % |        1 a row |
|    2 | `book_chunks`                                                                     |   **330.2** |       41.8 | 245,700 / 8,190 | 1,344 (5,098 for the top 30) |         832 (3,255) |     62 % | 33,677 / 9,011 |
|    3 | `sweep_brokers`                                                                   |       236.5 |      236.5 |         222,788 |                        1,062 |                 541 |     51 % |         25,768 |
|    4 | `footprints`                                                                      |       104.1 |      104.1 |         222,788 |                          467 |                 304 |     65 % |         10,426 |
|    5 | `broker_trades`                                                                   |        96.4 |       96.4 |       2,920,000 |                           33 |                  14 | **44 %** |              0 |
|    6 | `trades`                                                                          |        68.5 |       68.5 |       1,460,000 |                           47 |                  40 |     86 % |              0 |
|    7 | `candles`                                                                         |        29.1 |       29.1 |         222,788 |                          131 |                 109 |     84 % |              0 |
|    8 | `broker_code_chunks`                                                              |        12.0 |       12.0 |           1,460 |                        8,200 |               7,000 |     85 % |        1 a row |
|    9 | `live_prices`, `ajaib_books`, `cross_check_differences`, `facts`, `sqlite_schema` |         0.5 |        0.5 |                 |                              |                     |          |                |
|      | `walk_trades` (relay day)                                                         |         0.0 |        0.0 |               0 |                              |                     |          |                |
|      | **Total (`databaseSize`)**                                                        | **2,026.7** |  **627.1** |                 |                              |                     |          |                |
|      | of which live hours (at the seal)                                                 |     1,681.8 |      282.2 |                 |                              |                     |          |                |
|      | of which the evening walk                                                         |       344.9 |      344.9 |                 |                              |                     |          |                |

Notes on the rows:

- **Heatmaps hold most of it, mainly because of where SQLite puts the row.** A `WITHOUT ROWID` table is an index B-tree. With 4 KiB pages, a cell keeps at most about 1,002 bytes in the page and moves the rest to overflow pages, which no other row shares ([SQLite file format, §1.6 B-tree pages](https://www.sqlite.org/fileformat2.html#b_tree_pages)). A 3.1 KB heatmap row therefore takes a whole 4 KiB overflow page plus its in-page part. The text is six slices of about 40 `[price, bid, offer]` levels. Gzipped, the same rows would be 89 MB of payload instead of 770 MB, about 360 bytes a row. That fits in the page and needs no overflow. The runbook had already flagged heatmaps as the storage term and a tenth of the size gzipped. What it missed is K.
- **Book chunks** are gzipped, so they are smaller, but each chunk carries a whole start book. A busy code's chunk is 3–5 KB gzipped, and a quiet code's chunk is 0.5–1 KB.
- **`sweep_brokers` and `broker_trades`** are both written after the seal, in walk order, into B-trees keyed by something other than that order. The walk visits minutes newest first and recomputes every code of each, and the broker index is keyed broker first. So they split pages all over the tree: fill is 51 % and 44 %. A `VACUUM` of the K = 30 day shrank them from 236.5 to 181.7 MB and from 96.4 to 51.3 MB. That is most of the 627 → 516 MB (−18 %) it saved.
- **`walk_trades`** is empty on a relay day, because the tape held every number. On a day only the walks recorded, each walk row also lands in the tape. Whether that day also keeps all 1.46 M rows in `walk_trades` (roughly another 50–60 MB) depends on the order of `writeFields` and `walkTapeOf`, which this model did not trace.
- The KV `storage.put` keys (`trading-day-object.ts:112`, `:218`) are a few KB.

## Free pages, `auto_vacuum` and `VACUUM`

- **The churn leaves almost no free pages.** The model replaced footprints and candles once a minute (×1.5) and live prices 300 times. Ajaib replaced every broker codes chunk, Stockbit replaced every chunk again, and differences were inserted and deleted. After all of that, `freelist_count` was **1**. SQLite reuses a freed page for the next allocation, so a replace of the same size frees and takes back the same space.
- **`databaseSize` leaves free pages out anyway.** workerd computes it as `(page_count − freelist_count) × page_size` (`src/workerd/api/sql.c++`, `SqlStorage::getDatabaseSize`, workerd `bc7d179`). The seal's `Order flow storage` line logs this figure as `databaseBytes` (`day-store.ts:940`). Cloudflare's pricing page doesn't say how billed stored data is measured ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), read 2026-11-18). It says only that it is billed "until the data is removed" and that internal metadata tables count. So whether `storedBytes` in `durableObjectsSqlStorageGroups` is the same measure is **unconfirmed**.
- **Neither `auto_vacuum` nor `VACUUM` reaches user code.** `auto_vacuum` and `incremental_vacuum` are not in workerd's pragma allowlist (`ALLOWED_PRAGMAS`, `src/workerd/util/sqlite.c++:576`): user code may read `data_version` and `page_size`, a few boolean toggles, the foreign-key and index listings, `quick_check` and `optimize`. The open-source workerd never sets `auto_vacuum` (no match in the repo). Its only `VACUUM` is in a cluster test (`src/workerd/server/cluster/log_tests.rs`). Whether Cloudflare's production storage layer vacuums, and whether `ctx.storage.sql.exec("VACUUM")` is accepted, is **unconfirmed**: the authorizer has no case for it, and nothing in Cloudflare's docs mentions it. Since `databaseSize` already excludes free pages, a vacuum would recover only the partly filled pages: about 18 % of the K = 30 day, and less of the K = 900 day, whose heatmap overflow pages are full.

## Against the measured 1.3–1.8 GB

|                                                 |     Model day | Against 1.3–1.8 GB                  |
| ----------------------------------------------- | ------------: | ----------------------------------- |
| The runbook's K = 30                            |        627 MB | 0.35–0.48 of it                     |
| K = 900, every code every minute it has a frame |      2,027 MB | 1.1–1.6 times it                    |
| Fixed part (everything but the two book tables) |        547 MB |                                     |
| Each book code-minute                           |       6.02 KB | (1,149.2 + 330.2) MB / 245,700      |
| Book code-minutes that close the gap            | 125 K – 210 K | (1,300 or 1,800 − 547) MB / 6.02 KB |

The model at K = 30 falls well short. At K = 900 it overshoots. The gap closes at 460–770 codes with chunks in all 273 minutes, or 900 codes with chunks in 50–85 % of them. The extension subscribes `order_book` for every code in the code list (`apps/extension/src/worker/stockbit.ts:126`–`139`, fed by `codeList.codes` at `service-worker.ts:305`). The object records every changed served book, of any code (`order-books.ts:327` `takeChanged`, `trading-day.ts:689`). The comment at `stockbit.ts:120` proves 690 codes in one subscribe message. So **book chunks and heatmaps for most of the market** is the explanation that fits.

The candidates from the ticket, checked:

1. **Book chunks for far more codes than 30: yes, the main cause.** Above. The runbook's K was "codes some viewer selected or watched". The code records every code Stockbit sends a book for.
2. **A table written per frame: no.** No table is written per frame. Book frames go into a chunk held in memory and are written once a minute, when the chunk closes (`book-chunks.ts` `take`). Per-frame volume does show up in the size of each chunk.
3. **Freelist bloat: no.** One free page after the day's churn, and `databaseSize` excludes free pages. Partly filled pages are real, though: `broker_trades` at 44 % and `sweep_brokers` at 51 % carry about 100 MB a day of slack.

Two more terms add to a day's growth:

- **Evening walks of older days.** The namespace's daily growth is not one object. #532 found walks of older days on the same nights: 10-09 on 11-17, then 11-13 and 11-16 on 11-18. Each one adds that day's broker codes tables. That is 345 MB for a 1.46 M-trade day in the model, which is an upper bound, since the 11-15 rebuild of 12 days added 1.52 GB, or about 127 MB a day object.
- **The busy-day assumption.** The model day is 1.46 M trades. The trade counts for 11-16 to 11-18 were not read here. A lighter day shrinks the fixed part, but not the book part, which follows the codes and minutes with a frame, not the trades.

## What is unconfirmed

- **K on Production, and each code's minutes with a frame.** This is the figure the conclusion rests on. Two ways to read it without the cookie: the sums of `bookChunks` and `heatmaps` over a day's `Rows written` lines, and the seal's `Order flow storage` line (`heatmapRows`, `heatmapBytes`, `databaseBytes`). Workers Logs keeps both for 7 days, so 11-16 to 11-18 are readable until about 11-23. With the cookie: a sealed day's heatmap GET for an illiquid code that nobody watches. Rows there confirm it.
- **Heatmap and chunk bytes a row.** They come from the model's synthetic books (20 levels, 1–3 levels changed a frame, 3 % tick moves). Production's recorded heatmap and book chunk GETs (`packages/relay/src/recorded-day.ts`) would refine the 4.7 KB and 1.3 KB.
- **Sweeps a trade** (model 0.74, runbook 0.3). This moves `footprints` and `sweep_brokers`, the second- and fourth-largest tables. A recorded day's sweeps and sweep brokers GETs for a few codes would refine it.
- **Whether `storedBytes` equals `databaseSize`**, and whether the 11-16 to 11-18 figures lag a day. The 11-14 Saturday rose 0.66 GB with 0.26 M rows written, which suggests a lag.
- **Whether production SQLite vacuums**, and whether user code may run `VACUUM`. Above.
- **`walk_trades` on a walk-only day.** Above.

## Appendix: the scripts

Kept here, not in the repo, so the repo's dead-code gate doesn't see them. Save both outside the repo, then run from the repo root:

```sh
node <dir>/day-storage.mjs <db> --book-codes=30 > out30.json
node <dir>/day-storage.mjs <db> --book-codes=900 --no-vacuum > out900.json
node <dir>/table.mjs out30.json
```

`--no-codes` stops at the seal, and `--walk-day` also writes every trade to `walk_trades`. The K = 30 run takes about 30 s and peaks at 630 MB on disk (plus as much again for the `VACUUM`). The K = 900 run takes about 2 minutes and 2 GB.

<details><summary><code>day-storage.mjs</code></summary>

```js
// Day storage by table (apinrdw/kumora#546): builds one busy trading day's
// database in Node's SQLite with the real schemas from the market-live
// sources, written in the order the trading-day object writes it, with
// payloads made by the same encodings, then measures every table's bytes
// with dbstat.
//
// Save it outside the repo, then run it from the repo root:
//   node <path>/day-storage.mjs <db-path> [--book-codes=30] [--no-codes]
//     [--walk-day] > out.json
// --book-codes: how many codes record book chunks and heatmap rows.
// --no-codes: stop after the seal (no broker codes walk).
// --walk-day: the tape also lands in walk_trades (a day the relay missed).
import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"

const [dbPath = "day-storage.db", ...flags] = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = flags.find((f) => f.startsWith(`--${name}=`))
  return hit === undefined ? fallback : Number(hit.split("=")[1])
}
const BOOK_CODES = flag("book-codes", 30)
const withCodes = !flags.includes("--no-codes")
const walkDay = flags.includes("--walk-day")

const ROOT = pathToFileURL(`${process.cwd()}/`)
const source = (path) =>
  readFileSync(new URL(`apps/dashboard/src/server/market-live/${path}`, ROOT), "utf8")
const literals = (block) =>
  [...block.matchAll(/`([\s\S]*?)`/g)].map((m) => m[1]).filter((sql) => /^\s*CREATE/.test(sql))
const DAY_SCHEMA = literals(source("day-store.ts").match(/const SCHEMA = \[([\s\S]*?)\n\]/)[1])
const CODES_SCHEMA = literals(source("broker-codes.ts").match(/const SCHEMA = \[([\s\S]*?)\n\]/)[1])
const SWEEP_SCHEMA = source("sweep-brokers.ts").match(/const SCHEMA = `([\s\S]*?)`/)[1]

const MINUTE_MS = 60_000
const T = 1_460_000
const STOCKS = 900
const INDICES = 10
const MINUTES = 300
const BOOK_MINUTES = 273
const LATE_REWRITE = 0.5 // r = 1.5 writes a footprint and candle row
const AJAIB_BATCH = 1_830 // 1.5 M trades in ~820 batches (#531)
const STOCKBIT_BATCH = 1_000 // stockbit-walk.ts
const CHUNK = 1_000
const RECORD = 7
const DAY_START = Date.UTC(2026, 10, 13, 2, 0)
const minuteAt = (index) => DAY_START + (index < 150 ? index : index + 120) * MINUTE_MS

let seed = 546
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const zipf = (n, s) => {
  const cumulative = []
  let sum = 0
  for (let i = 0; i < n; i++) cumulative.push((sum += 1 / (i + 1) ** s))
  return () => {
    const target = random() * sum
    let low = 0
    let high = n - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (cumulative[middle] < target) low = middle + 1
      else high = middle
    }
    return low
  }
}
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const code = (i) =>
  [i % 26, (i / 26) % 26, (i / 676) % 26, 7].map((n) => LETTERS[Math.floor(n)]).join("")
const BROKERS = Array.from({ length: 90 }, (_, i) => LETTERS[i % 26] + LETTERS[Math.floor(i / 26) + 10])
const pickBroker = zipf(BROKERS.length, 1)
const pickCode = zipf(STOCKS, 0.9)
// IDX tick sizes.
const tickOf = (price) => (price < 200 ? 1 : price < 500 ? 2 : price < 2000 ? 5 : price < 5000 ? 10 : 25)

// The tape: numbers in time order, minutes weighted to the open and close.
const minuteWeight = Array.from({ length: MINUTES }, (_, i) => {
  const session = i < 150 ? i / 150 : (i - 150) / 150
  return 1 + 2 * (1 - session) ** 6 + 1.5 * session ** 6
})
const weightSum = minuteWeight.reduce((a, b) => a + b, 0)
const minuteStart = []
{
  let at = 0
  for (const w of minuteWeight) {
    minuteStart.push(Math.round(at))
    at += (w / weightSum) * T
  }
  minuteStart.push(T)
}
const tCode = new Uint16Array(T)
const tTime = new Float64Array(T)
const tPrice = new Float64Array(T)
const tLots = new Float64Array(T)
const tSide = new Uint8Array(T) // 0 buy, 1 sell
const tRG = new Uint8Array(T)
const tBuyer = new Uint8Array(T)
const tSeller = new Uint8Array(T)
const tBuyerF = new Uint8Array(T)
const tSellerF = new Uint8Array(T)
const tMinute = new Uint16Array(T)
const price = Array.from({ length: STOCKS }, () => Math.round(Math.exp(4 + random() * 5)))
const lastSide = new Uint8Array(STOCKS)
const lastAggressor = new Uint8Array(STOCKS)
const lastSecond = new Float64Array(STOCKS)
for (let m = 0; m < MINUTES; m++)
  for (let n = minuteStart[m]; n < minuteStart[m + 1]; n++) {
    const c = pickCode()
    const span = minuteStart[m + 1] - minuteStart[m]
    const time = minuteAt(m) + Math.floor(((n - minuteStart[m]) / span) * MINUTE_MS)
    const tick = tickOf(price[c])
    const step = random()
    if (step < 0.15) price[c] += tick
    else if (step < 0.3) price[c] = Math.max(50, price[c] - tick)
    const side = random() < 0.75 ? lastSide[c] : random() < 0.5 ? 0 : 1
    const second = Math.floor(time / 1000)
    const continues = side === lastSide[c] && second === lastSecond[c]
    const aggressor = continues && random() < 0.85 ? lastAggressor[c] : pickBroker()
    const passive = pickBroker()
    tCode[n] = c
    tTime[n] = time
    tPrice[n] = price[c]
    tLots[n] = Math.ceil(-Math.log(random()) * 40) * (random() < 0.02 ? 50 : 1)
    tSide[n] = side
    tRG[n] = random() < 0.97 ? 1 : 0
    tBuyer[n] = side === 0 ? aggressor : passive
    tSeller[n] = side === 0 ? passive : aggressor
    tBuyerF[n] = random() < 0.2 ? 1 : 0
    tSellerF[n] = random() < 0.2 ? 1 : 0
    tMinute[n] = m
    lastSide[c] = side
    lastAggressor[c] = aggressor
    lastSecond[c] = second
  }
const number = (n) => n + 1
const SIDE = ["buy", "sell"]

// Each code-minute's regular-board trades, in number order.
const codeMinutes = new Map() // key m*STOCKS+c -> [n...]
for (let n = 0; n < T; n++) {
  if (tRG[n] === 0) continue
  const key = tMinute[n] * STOCKS + tCode[n]
  let list = codeMinutes.get(key)
  if (list === undefined) codeMinutes.set(key, (list = []))
  list.push(n)
}
// sweeps.ts: grouped while they share a side and a second.
const sweepsOf = (trades) => {
  const sweeps = []
  for (const n of trades) {
    const last = sweeps.at(-1)
    if (last !== undefined && last.side === tSide[n] && Math.floor(last.time / 1000) === Math.floor(tTime[n] / 1000)) {
      last.members.push(n)
      continue
    }
    sweeps.push({ side: tSide[n], time: tTime[n], members: [n] })
  }
  return sweeps
}
const sweepTuple = (side, time, members) => {
  let lots = 0
  let value = 0
  for (const n of members) {
    lots += tLots[n]
    value += tPrice[n] * tLots[n] * 100
  }
  return [SIDE[side], String(number(members[0])), time, tPrice[members[0]], tPrice[members.at(-1)], lots, value, members.length]
}
// footprint-cells.ts and sweep-rows.ts.
const cellsText = (trades) => {
  const cells = new Map()
  for (const n of trades) {
    const lots = cells.get(tPrice[n]) ?? { sell: 0, buy: 0, none: 0 }
    lots[SIDE[tSide[n]]] += tLots[n]
    cells.set(tPrice[n], lots)
  }
  return JSON.stringify([...cells].sort(([a], [b]) => a - b).map(([p, l]) => [p, l.sell, l.buy, l.none]))
}
const sweepsText = (sweeps) => JSON.stringify(sweeps.map((s) => sweepTuple(s.side, s.time, s.members)))
// sweep-brokers.ts: each whole sweep split by aggressor broker, each piece
// with its brokers, largest lots first; only sweeps whose every trade has
// codes.
const brokersOf = (members, pick, foreign) => {
  const lots = new Map()
  for (const n of members) {
    const key = BROKERS[pick[n]] + (foreign[n] ? "F" : "D")
    lots.set(key, (lots.get(key) ?? 0) + tLots[n])
  }
  return [...lots].sort((a, b) => b[1] - a[1]).map(([k, l]) => [k.slice(0, 2), k[2], l])
}
const sweepBrokersText = (sweeps, coded) => {
  const out = []
  for (const sweep of sweeps) {
    if (!sweep.members.every(coded)) continue
    const [aggr, aggrF, other, otherF] =
      sweep.side === 0 ? [tBuyer, tBuyerF, tSeller, tSellerF] : [tSeller, tSellerF, tBuyer, tBuyerF]
    const pieces = new Map()
    for (const n of sweep.members) {
      const list = pieces.get(aggr[n]) ?? []
      list.push(n)
      pieces.set(aggr[n], list)
    }
    out.push([
      String(number(sweep.members[0])),
      [...pieces.values()].map((members) => [
        sweepTuple(sweep.side, tTime[members[0]], members),
        brokersOf(members, aggr, aggrF),
        brokersOf(members, other, otherF),
      ]),
    ])
  }
  return out.length === 0 ? undefined : JSON.stringify(out)
}

// Order books: 20 levels a side, a frame every ~0.5 s for the busiest code
// (~33 K frames a day, heatmap.ts), falling with rank; a code under one
// frame a minute has a chunk in that share of its minutes.
const framesPerMinute = (rank) => 120 / (1 + rank / 10)
const bookState = Array.from({ length: BOOK_CODES }, (_, r) => {
  const c = r
  const tick = tickOf(price[c])
  const side = (from, dir) =>
    Array.from({ length: 20 }, (_, i) => ({
      price: from + dir * i * tick,
      lots: Math.ceil(-Math.log(random()) * 2000),
      orders: 1 + Math.floor(random() * 80),
    }))
  return { c, tick, bids: side(price[c], -1), offers: side(price[c] + tick, 1) }
})
const touch = (levels) => {
  const out = levels.map((l) => ({ ...l }))
  const k = 1 + Math.floor(random() * 3)
  for (let i = 0; i < k; i++) {
    const at = Math.floor(random() ** 2 * 20)
    out[at].lots = Math.max(1, out[at].lots + Math.round((random() - 0.5) * 500))
    out[at].orders = Math.max(1, out[at].orders + (random() < 0.5 ? -1 : 1))
  }
  return out
}
const shift = (book, dir) => {
  const { tick } = book
  book.bids = book.bids.map((l) => ({ ...l, price: l.price + dir * tick }))
  book.offers = book.offers.map((l) => ({ ...l, price: l.price + dir * tick }))
}
const lotsOf = (levels) => levels.reduce((sum, l) => sum + l.lots, 0)
const HEAT_SLICE_MS = 10_000
const chunkAndSlices = (book, minute) => {
  const startBook = {
    _tag: "OrderBook",
    code: code(book.c),
    bids: book.bids,
    offers: book.offers,
    bidLots: lotsOf(book.bids) * 3,
    offerLots: lotsOf(book.offers) * 3,
    at: minute - 400,
    provenance: "Stockbit",
    previousClose: price[book.c],
  }
  const deltas = []
  const changes = [{ at: minute, bids: book.bids, offers: book.offers }]
  const frames = Math.max(1, Math.round(framesPerMinute(book.c)))
  for (let f = 0; f < frames; f++) {
    const servedAt = minute + Math.floor(((f + random()) / frames) * MINUTE_MS)
    if (random() < 0.03) shift(book, random() < 0.5 ? -1 : 1)
    const which = random()
    const delta = { servedAt, at: servedAt - 150 }
    if (which < 0.7) delta.bids = book.bids = touch(book.bids)
    if (which > 0.3) delta.offers = book.offers = touch(book.offers)
    delta.bidLots = lotsOf(book.bids) * 3
    delta.offerLots = lotsOf(book.offers) * 3
    deltas.push(delta)
    changes.push({ at: servedAt, bids: book.bids, offers: book.offers })
  }
  const chunk = JSON.stringify({ code: code(book.c), minute, start: startBook, deltas })
  // heatmap.ts: lot-milliseconds by price over each 10 s slice.
  const slices = []
  let next = 0
  let held
  for (let start = minute; start < minute + MINUTE_MS; start += HEAT_SLICE_MS) {
    const end = start + HEAT_SLICE_MS
    const weights = new Map()
    const add = (b, d) => {
      if (b === undefined) return
      for (const l of b.bids) {
        const w = weights.get(l.price) ?? { bid: 0, offer: 0 }
        w.bid += l.lots * d
        weights.set(l.price, w)
      }
      for (const l of b.offers) {
        const w = weights.get(l.price) ?? { bid: 0, offer: 0 }
        w.offer += l.lots * d
        weights.set(l.price, w)
      }
    }
    while (next < changes.length && changes[next].at <= start) held = changes[next++]
    let since = start
    for (; next < changes.length && changes[next].at < end; next++) {
      add(held, changes[next].at - since)
      held = changes[next]
      since = changes[next].at
    }
    add(held, end - since)
    const levels = []
    for (const [p, w] of [...weights].sort(([a], [b]) => a - b)) {
      const bid = Math.round(w.bid / HEAT_SLICE_MS)
      const offer = Math.round(w.offer / HEAT_SLICE_MS)
      if (bid > 0 || offer > 0) levels.push([p, bid, offer])
    }
    if (levels.length > 0) slices.push([(start - minute) / HEAT_SLICE_MS, levels])
  }
  return { chunk, slices: JSON.stringify(slices), rawChunkBytes: chunk.length }
}

const candleArgs = (c, m, trades) => {
  let volume = 0
  let value = 0
  let high = 0
  let low = Infinity
  let buy = 0
  let sell = 0
  for (const n of trades) {
    volume += tLots[n] * 100
    value += tPrice[n] * tLots[n] * 100
    high = Math.max(high, tPrice[n])
    low = Math.min(low, tPrice[n])
    if (tSide[n] === 0) buy += tPrice[n] * tLots[n] * 100
    else sell += tPrice[n] * tLots[n] * 100
  }
  const first = trades[0]
  const last = trades.at(-1)
  return [code(c), minuteAt(m), number(first), tPrice[first], number(last), tPrice[last], tTime[last], high, low, volume, value, trades.length, buy, sell]
}

if (existsSync(dbPath)) rmSync(dbPath)
const db = new DatabaseSync(dbPath)
for (const statement of [...DAY_SCHEMA, ...CODES_SCHEMA, SWEEP_SCHEMA]) db.exec(statement)
const run = (sql) => {
  const s = db.prepare(sql)
  return (...args) => s.run(...args)
}
const insTrade = run("INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
const insCandle = run("INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
const insFoot = run("INSERT OR REPLACE INTO footprints VALUES (?, ?, ?, ?, ?)")
const insPrice = run("INSERT OR REPLACE INTO live_prices VALUES (?, ?)")
const insChunk = run("INSERT OR REPLACE INTO book_chunks VALUES (?, ?, ?)")
const insHeat = run("INSERT OR REPLACE INTO heatmaps VALUES (?, ?, ?)")
const insAjaib = run("INSERT OR REPLACE INTO ajaib_books VALUES (?, ?)")
const insFact = run("INSERT OR REPLACE INTO facts VALUES (?, ?)")
const insWalk = run("INSERT OR IGNORE INTO walk_trades VALUES (?, ?, ?, ?, ?)")
const payload = {}
const addPayload = (table, bytes) => (payload[table] = (payload[table] ?? 0) + bytes)
let rawBookBytes = 0
let bookChunkRows = 0
let sweepCount = 0

const footprintRowsOf = (m) => {
  const rows = []
  for (let c = 0; c < STOCKS; c++) {
    const trades = codeMinutes.get(m * STOCKS + c)
    if (trades === undefined) continue
    const sweeps = sweepsOf(trades)
    rows.push([c, trades, cellsText(trades), sweepsText(sweeps), sweeps.length])
  }
  return rows
}
const writeOrderFlow = (m, rows, late) => {
  for (const [c, trades, cells, sweeps, count] of rows) {
    if (late && random() >= LATE_REWRITE) continue
    insCandle(...candleArgs(c, m, trades))
    insFoot(code(c), minuteAt(m), cells, sweeps, number(trades.at(-1)))
    if (!late) {
      addPayload("footprints", cells.length + sweeps.length)
      sweepCount += count
    }
  }
}
// The live day: one flush a minute (trading-day.ts `armFlush`). A flush
// writes the minute's trades, the settled minute before it, a late rewrite
// of half the minute before that, the closed book chunks, the live prices
// and Ajaib books that changed, and the feed-downs fact.
let previousRows
for (let m = 0; m <= MINUTES; m++) {
  db.exec("BEGIN")
  if (m < MINUTES)
    for (let n = minuteStart[m]; n < minuteStart[m + 1]; n++) {
      insTrade(number(n), tTime[n], code(tCode[n]), tPrice[n], tLots[n], SIDE[tSide[n]], tRG[n] ? "RG" : "NG", random() < 0.9 ? "Ajaib,Stockbit" : "Ajaib")
      if (walkDay) insWalk(number(n), code(tCode[n]), tPrice[n], tLots[n], tRG[n] ? "RG" : "NG")
    }
  if (m > 0) {
    if (previousRows !== undefined) writeOrderFlow(m - 2, previousRows, true)
    previousRows = footprintRowsOf(m - 1)
    writeOrderFlow(m - 1, previousRows, false)
    if (m - 1 < BOOK_MINUTES)
      for (const book of bookState) {
        if (random() >= framesPerMinute(book.c)) continue
        const { chunk, slices, rawChunkBytes } = chunkAndSlices(book, minuteAt(m - 1))
        const gz = new Uint8Array(gzipSync(chunk))
        rawBookBytes += rawChunkBytes
        bookChunkRows++
        insChunk(code(book.c), minuteAt(m - 1), gz)
        insHeat(code(book.c), minuteAt(m - 1), slices)
        addPayload("book_chunks", gz.length)
        addPayload("heatmaps", slices.length)
        addPayload("heatmaps if gzipped", gzipSync(slices).length)
      }
    for (let c = 0; c < STOCKS + INDICES; c++)
      insPrice(code(c), JSON.stringify({ code: code(c), time: minuteAt(m), last: 1234, volume: 123456700, value: 98765432100, frequency: 12345, previous: 1220, isIndex: c >= STOCKS, high: 1250, low: 1210, open: 1225, change: 14, changePercent: 1.1475409836065573, regularBoard: true }))
    for (let c = 0; c < Math.min(BOOK_CODES, 30); c++)
      insAjaib(code(c), JSON.stringify({ bids: bookState[c].bids.concat(bookState[c].bids), offers: bookState[c].offers.concat(bookState[c].offers), at: minuteAt(m) }))
    insFact("feed-downs", JSON.stringify([{ feed: "Stockbit", from: minuteAt(0), to: minuteAt(1) }]))
  }
  db.exec("COMMIT")
}
if (previousRows !== undefined) {
  db.exec("BEGIN")
  writeOrderFlow(MINUTES - 1, previousRows, true)
  db.exec("COMMIT")
}
for (const [key, value] of [["sealed", "2026-11-13T10:00:00Z"], ["gaps", '{"gaps":[]}'], ["tape-source", "relay"], ["order-flow-built", "built"]])
  insFact(key, value)
const measure = (label) => {
  const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size)
  const pages = Number(db.prepare("PRAGMA page_count").get().page_count)
  const free = Number(db.prepare("PRAGMA freelist_count").get().freelist_count)
  const tables = db
    .prepare(
      `SELECT name, count(*) AS pages, sum(pgsize) AS bytes, sum(payload) AS payload, sum(unused) AS unused,
        sum(pagetype = 'overflow') AS overflow, sum(ncell) AS cells
       FROM dbstat GROUP BY name ORDER BY bytes DESC`
    )
    .all()
    .map((row) => ({ ...row, fill: Number(row.payload) / Number(row.bytes) }))
  return { label, pageSize, pages, free, databaseSize: (pages - free) * pageSize, fileBytes: statSync(dbPath).size, tables }
}
const results = [measure("sealed, before the broker codes walk")]

if (withCodes) {
  const insChunkCodes = run("INSERT OR REPLACE INTO broker_code_chunks VALUES (?, ?)")
  const getChunk = db.prepare("SELECT codes FROM broker_code_chunks WHERE chunk = ?")
  const insIndex = run("INSERT OR IGNORE INTO broker_trades VALUES (?, ?, ?, ?)")
  const insDiff = run("INSERT OR REPLACE INTO cross_check_differences VALUES (?, ?, ?)")
  const insSweepBrokers = run("INSERT OR REPLACE INTO sweep_brokers VALUES (?, ?, ?)")
  const coded = new Uint8Array(T)
  const enc = new TextEncoder()
  const sweepRowsWritten = { n: 0 }
  const storedSweepText = new Map()
  const batch = (numbers, feed) => {
    db.exec("BEGIN")
    const chunks = new Map()
    for (const n of numbers) {
      const k = Math.floor(n / CHUNK)
      let held = chunks.get(k)
      if (held === undefined) {
        const row = getChunk.get(k)
        held = row === undefined ? new Uint8Array(CHUNK * RECORD) : new Uint8Array(row.codes)
        chunks.set(k, held)
      }
      const at = (n % CHUNK) * RECORD
      if (feed === "Ajaib") {
        held.set(enc.encode(`${BROKERS[tBuyer[n]]}${tBuyerF[n] ? "F" : "D"}${BROKERS[tSeller[n]]}${tSellerF[n] ? "F" : "D"}`), at)
        held[at + 6] = 65
        insIndex(BROKERS[tBuyer[n]], tBuyerF[n] ? "F" : "D", "buy", number(n))
        insIndex(BROKERS[tSeller[n]], tSellerF[n] ? "F" : "D", "sell", number(n))
        coded[n] = 1
      } else {
        held[at + 6] = 66
        if (random() < 0.0007) insDiff(number(n), held.slice(at, at + 6), enc.encode("ZZDYYD"))
      }
    }
    for (const [k, held] of chunks) insChunkCodes(k, held)
    if (feed === "Ajaib") {
      // sweep-brokers.ts `recompute`: the minutes the batch touched, each
      // code's row that changed.
      const minutes = new Set(numbers.map((n) => tMinute[n]))
      for (const m of minutes)
        for (let c = 0; c < STOCKS; c++) {
          const trades = codeMinutes.get(m * STOCKS + c)
          if (trades === undefined) continue
          const text = sweepBrokersText(sweepsOf(trades), (n) => coded[n] === 1)
          const key = m * STOCKS + c
          if (text === undefined || storedSweepText.get(key) === text.length) continue
          storedSweepText.set(key, text.length)
          insSweepBrokers(code(c), minuteAt(m), text)
          sweepRowsWritten.n++
        }
    }
    db.exec("COMMIT")
  }
  // Ajaib's walk, newest first.
  for (let high = T; high > 0; high -= AJAIB_BATCH) {
    const numbers = []
    for (let n = high - 1; n >= Math.max(0, high - AJAIB_BATCH); n--) numbers.push(n)
    batch(numbers, "Ajaib")
  }
  results.push({ ...measure("after Ajaib's walk"), sweepBrokerWrites: sweepRowsWritten.n })
  // Stockbit's cross-check, forward from trade 1: every chunk replaced again.
  for (let low = 0; low < T; low += STOCKBIT_BATCH) {
    const numbers = []
    for (let n = low; n < Math.min(T, low + STOCKBIT_BATCH); n++) numbers.push(n)
    batch(numbers, "Stockbit")
  }
  results.push(measure("after Stockbit's cross-check"))
  addPayload("sweep_brokers", Number(db.prepare("SELECT sum(length(sweeps)) AS b FROM sweep_brokers").get().b))
}
if (!flags.includes("--no-vacuum")) {
db.exec("PRAGMA temp_store = MEMORY")
db.exec("VACUUM")
results.push(measure("after VACUUM"))
}
db.close()

console.log(
  JSON.stringify(
    {
      bookCodes: BOOK_CODES,
      walkDay,
      trades: T,
      codeMinutes: codeMinutes.size,
      sweeps: sweepCount,
      sweepsPerTrade: sweepCount / T,
      rawBookBytes,
      bookChunkRows,
      payload,
      results,
    },
    (_, v) => (typeof v === "bigint" ? Number(v) : v),
    1
  )
)
```

</details>

<details><summary><code>table.mjs</code></summary>

```js
// Prints day-storage.mjs's JSON as Markdown tables: node table.mjs out.json
import { readFileSync } from "node:fs"

const out = JSON.parse(readFileSync(process.argv[2], "utf8"))
const mb = (b) => (Number(b) / 1e6).toFixed(1)
console.log(
  `book codes ${out.bookCodes}, trades ${out.trades}, code-minutes ${out.codeMinutes}, sweeps ${out.sweeps} (${out.sweepsPerTrade.toFixed(3)} a trade), raw book JSON ${mb(out.rawBookBytes)} MB`
)
console.log("payload MB", Object.fromEntries(Object.entries(out.payload).map(([k, v]) => [k, mb(v)])))
for (const r of out.results) {
  console.log(`\n### ${r.label}: databaseSize ${mb(r.databaseSize)} MB, file ${mb(r.fileBytes)} MB, free pages ${r.free} (${mb(r.free * r.pageSize)} MB)${r.sweepBrokerWrites ? `, sweep brokers writes ${r.sweepBrokerWrites}` : ""}\n`)
  console.log("| B-tree | MB | payload MB | fill | overflow pages | cells |")
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |")
  for (const t of r.tables)
    console.log(`| ${t.name} | ${mb(t.bytes)} | ${mb(t.payload)} | ${(t.fill * 100).toFixed(0)} % | ${t.overflow} | ${t.cells} |`)
}
```

</details>
