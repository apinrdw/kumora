# Order flow cost check on Staging

Spec [apinrdw/kumora#263](https://github.com/apinrdw/kumora/issues/263), ticket [apinrdw/kumora#270](https://github.com/apinrdw/kumora/issues/270). Before the order flow rows run on Production, run one full trading day on Staging. Then report the row writes, the storage and a monthly estimate at Production volume on the spec's PR. If the estimate is above **$40 a month**, stop. Do not merge until the owner decides.

A human does these steps. An agent cannot deploy, run the relay or read Workers Logs.

## What the day measures

The trading-day Durable Object logs two kinds of structured lines (`trading-day.ts` logs them, from the meter `day-store.ts` keeps), which Workers Logs keeps (`observability` is on for every stack, `packages/deploy/src/stack.ts`):

- **`Rows written`**: one line for each flush, about once a minute. Each field is the number of rows that flush wrote to one table. The fields are `trades`, `candles`, `footprints`, `heatmaps`, `bookChunks`, `livePrices`, `ajaibBooks` and `facts`. `billedRowsWritten` is what the SQLite cursors counted, which is the figure Cloudflare bills. `minuteRereads` counts the late trades that read a stored minute back (#266's re-read). `billedMinuteRereadRows` is the number of rows those re-reads read.
- **`Order flow storage`**: one line at the seal, at 17:00 WIB. The fields are `footprintRows`, `footprintBytes`, `heatmapRows` and `heatmapBytes` (the payload bytes of the two new tables), and `databaseBytes` (the whole day's database).

The lines are per flush, so a restart loses no more than one flush's counts. Add up the lines for the day.

## Before the day

1. Push the spec's branch to `staging`. Workers Builds deploys it to Staging (`docs/runbooks/deploy.md`, section 4). The dashboard Worker is `kumora-dashboard-staging`.
2. On a trading day, before 08:45 WIB, set the relay extension's target to Staging with Staging's `INGEST_TOKEN`. Keep it relaying until after 16:15 WIB.
3. Open Market Live on Staging, and select and watch the codes you watch on Production. Book chunks, and so heatmap rows, are recorded only for some codes: `book-chunks.ts` and `order-books.ts` decide which. Write down how many codes that is. This is **K_staging**.
4. Do not deploy Staging during the day. A deploy restarts the object and costs a reconnect and a backfill. The backfill is a burst of late trades, which inflates `minuteRereads`.

## After 17:00 WIB

1. Open `kumora-dashboard-staging`'s logs in the Query Builder. Cloudflare's [Query Builder page](https://developers.cloudflare.com/workers/observability/query-builder/), read 2026-11-14, gives the path: Workers & Pages, the Worker, then Observability. It keeps logs for seven days, so run this within a week of the day.
2. Filter on the message `Rows written` (the `$metadata.message` key) and the day, 08:00–17:05 WIB. Sum each field across the lines.
3. Filter on the message `Order flow storage` and read its one line.
4. Read the day's trade count, **T_staging**: the day strip's figure for the day on Staging (`trades`), or the `trades` sum from step 2.
5. Optional cross-check: the `TradingDay` namespace's Metrics tab. Cloudflare's [Durable Objects metrics page](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/), read 2026-11-14, gives the path: Durable Objects, the namespace, then Metrics. That page does not list the tab's charts, so whether it shows SQL rows written is unconfirmed. If it does, they should be close to the sum of `billedRowsWritten`.

## The estimate model

Price it at Production's busiest measured day: **T_prod = 1,460,000 trades** ([apinrdw/kumora#258](https://github.com/apinrdw/kumora/issues/258), 2026-11-13). Use 22 trading days a month. The prices are Cloudflare's Durable Object SQLite prices on Workers Paid, read 2026-11-14 from <https://developers.cloudflare.com/durable-objects/platform/pricing/>:

| What | Included each month | Over that |
| --- | --- | --- |
| Rows written | 50 M | $1.00 per million |
| Rows read | 25 B | $0.001 per million |
| Stored data | 5 GB-month | $0.20 per GB-month |

The included amounts are account-wide, and the existing tape alone writes about 32 M trade rows a month at this volume. So the model prices the order flow tables at the overage rate, with nothing included.

With `s = T_prod / T_staging` and `k = K_prod / K_staging`:

- Footprint writes a month: `F = 22 × s × Σfootprints`
- Heatmap writes a month: `H = 22 × k × Σheatmaps`
- Re-read rows a month: `R = 22 × s × ΣbilledMinuteRereadRows`
- Storage added a month, in GB: `G = 22 × (s × footprintBytes + k × heatmapBytes) / 10⁹`
- Monthly cost in month `m` after shipping: `(F + H) × $1/M + R × $0.001/M + m × G × $0.20`

If `billedRowsWritten` is well above the plain row counts, a replaced row bills more than one row write. Then scale F and H by `ΣbilledRowsWritten / Σ(all row fields)`.

Storage only grows, because no day is ever deleted. Report the cost for month 1 and month 12.

The one-off build of the days sealed before the ship runs once per day, on that day's first order flow GET. `order-flow-build.ts` builds it, and its `orderFlowBuiltAtStart` decides which days need it. It writes about one footprint row per stock-minute plus one heatmap row per book chunk. That is roughly one day's footprint and heatmap writes for each such day, once.

## First estimate, before Staging (2026-11-14)

This estimate comes from the measured scale alone. Its inputs are assumptions until the Staging day replaces them.

| Input | Value | Basis |
| --- | --- | --- |
| Stock-minutes with a regular-board trade, P | 150 K a day; upper bound 270 K | about 900 stocks × about 300 trading minutes is the bound |
| Writes per footprint row, r | 1.5; upper bound 2 | written at the flush after its minute, again when a trade landed after that flush |
| Codes with books, K | 30; upper bound 100 | codes some viewer selected or watched |
| Book chunk minutes per code | 273 | #258: BBCA and VKTR |
| Footprint row bytes | about 45–65 MB a day | 0.3 sweeps per trade × 1.46 M × about 48 B, plus cells of about 150 B a row |
| Heatmap row bytes | about 13.5 KB | 6 slices × about 150 prices × about 15 B of JSON |
| Late-trade re-reads | 1 K a day × 30 K rows | the peak minute holds about 30 K whole-market trades |

| | Expected (P 150 K, r 1.5, K 30) | Upper (P 270 K, r 2, K 100) |
| --- | --- | --- |
| Footprint writes | 4.95 M → $4.95 | 11.9 M → $11.88 |
| Heatmap writes | 0.18 M → $0.18 | 0.60 M → $0.60 |
| Re-read rows | 0.66 B → $0.00 | 6.6 B (10 K a day) → $0.01 |
| Storage added a month | 1.0 + 2.4 = 3.4 GB → +$0.68 | 1.4 + 8.1 = 9.5 GB → +$1.90 |
| **Month 1** | **about $6** | **about $14** |
| **Month 12** | **about $13** | **about $35** |

Both columns stay under $40 a month for the first year. The storage term never stops growing, and heatmap rows are most of it. Heatmap rows are stored as plain JSON. Book chunks are gzipped (the Decision on `chunkOf` in `day-store.ts`), and a gzipped heatmap row would be about a tenth of the size. At the upper bound, the estimate crosses $40 around month 15. If a replaced row bills as two row writes, the footprint term doubles, and the upper column reaches about $26 in month 1.

## Sweep brokers: one Staging evening

Spec [apinrdw/kumora#343](https://github.com/apinrdw/kumora/issues/343), ticket [apinrdw/kumora#348](https://github.com/apinrdw/kumora/issues/348). The sweep brokers table (`sweep-brokers.ts`) holds one row per stock code and minute with sweeps. Each broker codes batch rewrites the rows of every minute it touches, so its cost comes after the close, while the evening walk runs. Before the spec's branch reaches Production, run one Staging evening through the walk to `complete`. Then report the figures and the extended estimate on the spec's PR. The stop is the same: the order flow tables plus the sweep brokers table must stay under **$40 a month**. If the estimate is above it, stop. Do not merge to Production until the owner decides.

### What the evening measures

- **`Rows written`** gains `sweepBrokers` (sweep brokers rows replaced or deleted), `sweepBrokerMinutes` (minutes a recompute read back) and `billedSweepBrokerReadRows` (the rows those recomputes read, as billed). A batch that lands before the 17:00 seal adds these to the next flush's line.
- **`Sweep brokers recomputed`**: one line for each batch after the seal, with the same fields as `Rows written`. Its `billedRowsWritten` is that batch's billed writes. The one-off build of a day whose codes landed before this shipped logs one such line when it ends.
- **`Order flow storage`** gains `sweepBrokerRows` and `sweepBrokerBytes` (the table's rows and payload bytes). The seal's line shows them near 0, because codes arrive after it. The object logs the line again the first time it finds the sealed day's codes complete. Read that later line. If the object restarted during the walk, it logs the line again: take the last one.

### The evening

1. Run the order flow day above on the same Staging deploy, or any Staging trading day with a tape.
2. After 17:00 WIB, point the relay extension's broker codes walk at Staging and let it run. Keep it running until the day's broker codes status reads `complete`. Let Stockbit's cross-check walk finish too, if it runs, because its batches also recompute.
3. In the Query Builder, filter on the day's `Rows written` lines from 16:00 WIB on, and on its `Sweep brokers recomputed` lines. Sum `sweepBrokers`, `sweepBrokerMinutes`, `billedSweepBrokerReadRows` and `billedRowsWritten` across both.
4. Read the last `Order flow storage` line for `sweepBrokerRows` and `sweepBrokerBytes`.

### The extended estimate

Use the same `s = T_prod / T_staging`, 22 trading days and prices as in [The estimate model](#the-estimate-model). Add these terms:

- Sweep brokers writes a month: `W = 22 × s × ΣsweepBrokers`. If `ΣbilledRowsWritten` over the `Sweep brokers recomputed` lines is well above their `ΣsweepBrokers`, scale `W` by that ratio.
- Sweep brokers rows read a month: `B = 22 × s × ΣbilledSweepBrokerReadRows`
- Storage added a month, in GB: `G_sb = 22 × s × sweepBrokerBytes / 10⁹`

The monthly cost in month `m` after shipping becomes:

`(F + H + W) × $1/M + (R + B) × $0.001/M + m × (G + G_sb) × $0.20`

Report it for month 1 and month 12, beside the order flow figures alone.

The one-off build (`builtFirst` in `sweep-brokers.ts`) runs once for each day whose codes landed before this shipped, on that day's first sweep brokers GET. It reads the whole day's tape once and writes about one row per stock-minute with a sided sweep. That costs about one evening's `ΣsweepBrokers` divided by the rewrite factor `r_sb` below, once for each such day.

### First estimate, before Staging (2026-11-15)

| Input | Value | Basis |
| --- | --- | --- |
| Stock-minutes with a sided sweep, P_sb | 150 K a day; upper bound 270 K | as P above: no more than the footprint rows |
| Rewrites per row, r_sb | 2; upper bound 4 | each batch rewrites every row of the minutes it touches. Ajaib's walk pages 5,000 trades, so a busy minute of 30 K trades is rewritten about 6 times and a quiet one once or twice. Stockbit's cross-check batches add more. |
| Row bytes | about 30–45 MB a day | 0.3 sweeps per trade × 1.46 M, at about 70–100 B of JSON for each sweep's brokers |
| Rows read for each batch | the touched minutes' whole market | about 300 Ajaib batches a day × up to 30 K rows |

| | Expected (P_sb 150 K, r_sb 2) | Upper (P_sb 270 K, r_sb 4) |
| --- | --- | --- |
| Sweep brokers writes | 6.6 M → $6.60 | 23.8 M → $23.76 |
| Rows read | about 0.2 B → $0.00 | about 0.4 B → $0.00 |
| Storage added a month | 0.7–1.0 GB → +$0.20 | 1.0 GB → +$0.20 |
| **Order flow plus sweep brokers, month 1** | **about $13** | **about $38** |
| **Order flow plus sweep brokers, month 12** | **about $22** | **about $61** |

The expected column stays under $40 for the first year. The upper column crosses it in month 2, because the rewrite factor multiplies the writes. The Staging evening measures `r_sb` directly: it is `ΣsweepBrokers / sweepBrokerRows`. If the measured estimate is above $40, the lever is to skip a row whose bytes did not change. A batch then writes only the codes whose sweeps it completed or changed.
