# How a day's broker codes join its tape, and how big one day's per-broker totals are

Ticket [apinrdw/kumora#418](https://github.com/apinrdw/kumora/issues/418), map [apinrdw/kumora#417](https://github.com/apinrdw/kumora/issues/417). Read from the code at `dbb667daea` (staging, 2026-11-16). No production day was read: the owner's session cookie was not available, so the sizes below are estimates, and the production day count is an open question.

## Answer

- **The join is by trade number, and the code is only on the tape side.** The tape's `trades` table holds `code`, `price`, `lots`, `side` and `board` for each trade, keyed by `number` with no index on `code`. The broker codes store holds each trade's buyer, buyer type, seller and seller type by trade number, with no stock code. A per-stock total therefore reads trades for the code, price and lots, and reads the codes by number.
- **One stock code costs the same read as every stock code.** The tape has no code index, so even one code's totals read the whole day's `trades` table: about 1.46 M rows on the busiest measured day. Build every (stock code, broker) row in one pass, not one code on demand.
- **Regular board plus auction matches is `board = 'RG'`.** Auction matches are regular-board trades from pre-opening and pre-closing, stored with `side = 'none'`. The minute reads of the order flow and sweep brokers code filter the same way. `TN` (cash) and `NG` (negotiated) are excluded with that filter.
- **Rows per day: about 20 K–50 K (stock code, broker) rows, or up to about 60 K with investor type split out.** The upper bound is about 850 traded codes × 92 brokers × 2 investor types ≈ 156 K. This is an estimate, not a measurement.
- **Compute: about 1.6 s for a 1.46 M-trade day in Node's SQLite, a single ordered pass.** Expect a few seconds of CPU inside TradingDay. It reads about 1.46 M billed rows (≈ $0.0015 at overage prices). An SQL `GROUP BY` over the `broker_trades` index takes about 2.7 s and reads about 3× the rows.
- **Days with codes but no recorded tape cannot yield totals.** A broker codes batch carries only trade numbers and codes. A History walk day from before the terminal's first recorded day holds codes but no `code`, `price`, `lots` or `board`. The picker's "as far back as stored broker codes go" therefore reaches only as far as days that also have a recorded tape.
- **Days of complete broker codes in production: unknown (open).** The ingest reached Production in release `v0.1.0-20261114`, published 2026-11-14 08:14 UTC, a Saturday. No evening walk had run before it. Any complete days come from the History walk since then, and today (2026-11-16) is still to walk.

## How TradingDay holds the tape

`apps/dashboard/src/server/market-live/day-store.ts`, `SCHEMA` (the Decision above it):

- `trades (number INTEGER PRIMARY KEY, time, code, price, lots, side, board, feeds)`. One row per trade, keyed by its trade number as the rowid, with **no secondary index**, so that each insert writes one row. Every board is stored: `board` is `RG`, `TN` or `NG`.
- `minuteTrades(minute)` reads the whole market's trades in a minute and keeps `board === "RG"`. `storedMinuteTrades(code, minute)` filters by code in JS, because "the trades table has no code index". Sweep brokers recompute through `minuteTrades` (`sweep-brokers.ts`, `minuteRows`).

Auction matches: `trading-day.ts`, `settleSide` (the Decision above it). A trade that falls in pre-opening or pre-closing, or on `NG`, is stored with `side: "none"`. Auction matches keep their board, `RG`. The glossary's **Auction match** and **Board** agree. So "regular board plus auction matches", as candles count them, is exactly `board = 'RG'`.

A trade's value is `price × lots × SHARES_PER_LOT` (100), as `packages/relay/src/sweeps.ts` computes a sweep's value. The tape stores no value column.

## How TradingDay holds the broker codes

`apps/dashboard/src/server/market-live/broker-codes.ts`, in the same SQLite database as the tape:

- `broker_code_chunks (chunk INTEGER PRIMARY KEY, codes BLOB)`. Chunk `k` holds trades `1000k+1 .. 1000k+1000` as 1,000 fixed 7-byte records: buyer code (2), buyer type (1), seller code (2), seller type (1), source byte (`A`/`S`/`B`). All zero bytes is an absent trade. A 1.5 M-trade day is about 1,500 rows and about 10 MB.
- `broker_trades (broker, investor_type, side, number) WITHOUT ROWID`, primary key in that order. It has two rows per coded trade (buy side and sell side) and exists so that Data Studio can filter a whole day by broker. It has no stock code, and its key does not lead with `number`.
- `cross_check_differences` and the facts `broker-codes-n` and `cross-check` hold the cross-check and N. Totals do not need them.
- `isComplete` is the day's status `complete`: every trade 1..N has codes. It is cached until the next batch. `heldCodes(numbers)` reads the codes of listed trades, one chunk read per chunk touched.

The batch shape (`packages/relay/src/broker-codes.ts`, `BrokerCodesBatch`) is `rows: [tradeNumber, {buyer, buyerType, seller, sellerType}][]`. Stockbit's and Ajaib's post-close rows do carry `code`, `price`, `lot` and the board (`docs/research/stockbit-post-close-broker-codes.md`, "row fields" and "Board coverage"), but the extension posts only the codes. So:

- A day the relay recorded has both tables, which join on trade number.
- A day with no recorded tape (a History walk day from before the terminal's first recorded day, or a day the relay missed) gets a codes-only TradingDay. It never seals and is never listed (`trading-day.ts`, the Decision on `noTape`). It holds codes with nothing to price, size or attribute to a stock code. Totals for such a day need the walk to also post code, price, lots and board, which is a change to the ingest and its protocol version.
- On a recorded day, a trade that has codes but is missing from the tape (an unfilled relay gap) is dropped from every total. A coded day can be `complete` while its tape still misses trades. Completeness for totals is codes complete plus a tape with no gaps.

## What computing per-broker totals takes

The goal per row: (stock code, broker code, investor type), with lots and value bought and lots and value sold, over `RG` trades. The average buy and sell prices are value ÷ (lots × 100) and need no extra field.

### Option A: one ordered pass over trades and chunks (recommended)

Both tables are clustered on trade number: `trades` by rowid, `broker_code_chunks` by chunk. Walk them together a page at a time (for example 64 chunks, about 64 K trades, as `SCAN_PAGE` does for the status scan):

1. `SELECT chunk, codes FROM broker_code_chunks WHERE chunk BETWEEN ? AND ?`
2. `SELECT number, code, price, lots FROM trades WHERE number BETWEEN ? AND ? AND board = 'RG'`
3. For each trade, read its 7-byte record at `((number−1) % 1000) × 7`. Skip absent records, then add lots and value to `(code, buyer, buyerType)` buy and `(code, seller, sellerType)` sell in a `Map`.

Paging keeps memory bounded. `sql.exec` returns an array, so one unpaged `SELECT` of 1.46 M trades would build every row object at once, about 300 MB against a Durable Object's 128 MB. The rows read are about N + N/1000.

### Option B: SQL join on `broker_trades`

`SELECT t.code, b.broker, b.investor_type, b.side, sum(t.lots), sum(t.lots*t.price*100) FROM broker_trades b JOIN trades t ON t.number = b.number WHERE t.board = 'RG' GROUP BY 1,2,3,4`. This reads 2N index rows plus N rowid lookups and sorts the groups in a temporary B-tree. It needs the index to be built (`broker-trades` fact, `indexPage`). It is slower and costs about 3× the rows read.

### Option C: sum the sweep brokers rows (not enough)

`sweep_brokers` is keyed by `(code, minute)`, so one code's rows are a key range. It already splits whole sweeps and auction matches by broker. However, it carries only per-broker **lots**: a broker entry is `[code, investorType, lots, minorTypeLots?]`, and value exists only per piece. A sided piece's other side spans several brokers and prices, so value bought or sold per broker cannot be recovered from it. It also folds a broker's two investor types into a majority type. It can serve as a cheap per-code check of net lots, but not for the summary.

### Measured cost (synthetic day)

The benchmark is `bench.mjs`, kept outside the repo. It builds the exact `trades`, `broker_code_chunks` and `broker_trades` schemas in Node 26 `node:sqlite` (in-memory). The day has 1,460,000 trades over 900 codes and 95 brokers, both Zipf-distributed, 98% `RG`, 30% foreign per side.

| Approach                                  | Wall time (2 runs) | Rows read                              |
| ----------------------------------------- | ------------------ | -------------------------------------- |
| A: ordered pass, 64-chunk pages, JS `Map` | 1.68 s, 1.61 s     | 1.43 M                                 |
| B: SQL join + `GROUP BY`                  | 2.67 s, 2.67 s     | ≈ 4.4 M (2.9 M index + 1.46 M lookups) |

Caveats:

- workerd's Durable Object SQLite is file-backed and runs the same engine through a different binding. Expect the same order of magnitude, a few seconds of CPU, which is well under a Durable Object request's default 30 s CPU limit.
- Rows read at Cloudflare's overage price ($0.001 per million) cost about $0.0015 a day for A.
- The compute runs under the object's `turn` permit, which serializes every callback (`trading-day.ts`, the Decision on `turn`). On a live day, a few seconds under the permit would stall the ingest. Today's totals join only once codes are complete, at about 17:00 WIB, after the seal (`sealAt`). So running the compute after the seal, or on a past day's object, stalls nothing.
- The synthetic day produced only 5,784 (code, broker, type) rows, because the Zipf tails make the tail brokers and codes rare. That figure reflects the generator, not the market, so it is not used as the row estimate.

## How many (stock code, broker) rows one day yields

Reasoned estimate, pending a production read:

- About 850–900 codes trade on a day. IDX has about 92 active exchange member brokers.
- Liquid codes (about 300, with thousands of trades each) see most brokers on at least one side: about 60–90 each, ≈ 20–25 K pairs.
- Mid codes (about 300, with 50–1,000 trades) see about 15–40 brokers each, ≈ 5–10 K pairs.
- Thin codes (about 300, under 50 trades) see a few brokers each, ≈ 1–2 K pairs.
- **≈ 25–40 K (code, broker) pairs. Splitting by investor type adds the brokers that trade for both domestic and foreign investors in a code, about 1.2–1.5×, for ≈ 30–60 K rows. The hard ceiling is ≈ 156 K.**

At about 50 B a row (code, broker, type, four numbers), one day's totals are about 1.5–3 MB, or about 0.6 GB a year of 250 days, if stored. Per code, a liquid code is about 90–180 rows a day. A year-long range for one code is then about 45 K rows: about 2 MB of numbers before encoding.

A production read settles the estimate with one query on a complete recorded day: `SELECT count(*) FROM (SELECT DISTINCT t.code, b.broker, b.investor_type FROM broker_trades b JOIN trades t ON t.number = b.number WHERE t.board = 'RG')`. That read needs Data Studio or a new route, and the owner's access (see `docs/agents/production-reads.md`).

## How many days of complete broker codes production holds

Not read. The ingest (PR [#255](https://github.com/apinrdw/kumora/pull/255), merged 2026-11-14 02:44 UTC) is first in release `v0.1.0-20261114`, published 2026-11-14 08:14 UTC, a Saturday. So no evening walk ran before it, and today, 2026-11-16, is still to walk. Since the release, only the History walk could have completed days: Friday 2026-11-13 first, then older days, newest first. It runs at about 245 browser-hours a year of history (#130), so a weekend of walking is days to weeks of history, not months.

Of those days, only the ones the relay also recorded have a tape and can carry totals. Days from before the terminal's first recorded day are codes-only (see the section on broker codes above). The owner's extension options page ("Broker codes" section, last 10 days) shows the complete days directly. The dashboard's day strip lists the days with a tape.

## Open questions

1. The real (stock code, broker, investor type) row count for one complete production day. Run the query above once on a complete day.
2. How many days in Production hold complete codes **and** a recorded tape. Only those days can carry totals.
3. Whether the History walk should post `code`, `price`, `lots` and `board` with each trade, so that older days can yield totals. That is a protocol change for #244's ingest, and it is the only way the picker can reach back past the terminal's first recorded day.
4. Whether a recorded day's tape gaps (trades with codes but no tape row) need their own "complete for totals" check beside the codes status.
