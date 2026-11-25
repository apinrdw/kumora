# What re-asks a sealed day object all night, and what drives the walk bursts

Research for [#545](https://github.com/apinrdw/kumora/issues/545), map [#529](https://github.com/apinrdw/kumora/issues/529). The figures come from the resolution comment of [#532](https://github.com/apinrdw/kumora/issues/532). Written 2026-11-18 against `origin/staging` at `4b8a6ceb7d`. All `file:line` references are at that commit.

## Short answer

**The overnight plateau comes from the dashboard, not the extension.** A `/market-live` tab left open on the newest sealed day rechecks that day's broker codes every 30 s while they are incomplete. It runs two loops, one for the tape's codes and one for the selected stock's sweep brokers, so the day object gets about 2 GETs every ~32 s, or about 223 an hour. The object holds no socket and no timer between these GETs, so Cloudflare hibernates it after 10 s idle. Each GET then wakes a fresh instance. That instance has lost the in-memory `codesComplete` cache, so it runs the broker codes status scan again: one full pass over the day's trades, and nothing written. The loops stop only when an answer says `complete`, and a day that Stockbit lacks a few trades for never becomes complete. The tab also stops at 08:40 WIB, when `/market-live` switches to the live day.

**The bursts come from the extension's Stockbit gap walk of an older incomplete day.** Before `83ba334696` (2026-11-18 08:02, extension 0.0.39), the walk of a missing range that Stockbit's tape lacks a trade in paged on to the day's end. At full pace that is 3 calls/s and 10 calls a batch, so about 1,078 batches an hour. Each batch on a sealed, incomplete day runs one or two status scans after it is written. Each batch writes only its chunk rows.

| | Overnight plateau | Bursts |
| --- | --- | --- |
| Sender | Dashboard page (`@workspace/client` rechecks) | Extension, Stockbit gap walk |
| Request | `GET /market-live/days/<day>/broker-codes?at=…` and `GET …/sweep-brokers/<code>` (both with `cache: "reload"`) | `POST /api/broker-codes/<day>` (a batch of about 1,000 trades) |
| Cadence | each loop: sleep 30 s after its answer, about 2 GETs every 32 s | one batch every 10 paced calls × 334 ms = 3.34 s, about 1,078 an hour |
| Scans per request | 1 (`codesComplete` on a cold instance) | 1 (`sweepBrokers.completed`), plus 1 (`totalsWritten`'s `buildable`) when the day's broker totals aren't current and no build wake is set |
| Rows written | 0 | the touched chunk rows, plus a fact or two |
| Stop condition | an answer with `complete: true`, or the tab leaves the recorded day (08:40 WIB) | the range's trades are all seen (before the fix), which never happens for a trade Stockbit lacks, so it stops at the tape's end |
| Why it doesn't stop | the day's codes stay incomplete, and the cache that should make repeats free dies with each hibernation | the missing trade never comes; the day stays incomplete and in the list, so each run walks it again |

## The overnight plateau

### The request and its loop

`/market-live` opens a recorded day while the market is shut. `closedMarketAt` changes its answer at `08:40`, `17:00` and `24:00` WIB (`apps/dashboard/src/server/market-live/closed-market.ts:32`). So a tab left open shows the newest sealed day from 17:00 until 08:40 the next morning.

On a recorded day the page runs two loops against that day's object:

1. **The tape's codes.** `followTape` starts `codes.recheck` (`apps/dashboard/src/components/market-live/recorded-day.tsx:219-228`, mounted at `:328`). `makeBrokerCodesFollower` loops `while (!complete)`: it sleeps `CODES_RECHECK` (30 s), then asks `fetchRecordedBrokerCodes(date, latest, fresh = true)` (`packages/client/src/recorded-day.ts:167-208`). The ask uses `cache: "reload"` (`:46`), so it always reaches the Worker.
2. **The selected stock's sweep brokers.** The sweep log runs `followSweepBrokers` on a recorded day for any code outside `INDEX_CODES` (`apps/dashboard/src/components/market-live/sweep-log.tsx:140-154`). It loops `while (!done)`: it sleeps 30 s and asks again past the browser's copy (`packages/client/src/recorded-day.ts:219-241`).

Each loop sleeps 30 s after its answer arrives. With 2 loops, 3600 / (30 + L) × 2 = 223 an hour gives a round-trip L of about 2.3 s, which fits a cold object start plus a scan of 1.6 M rows. The existing test `while incomplete, asks again for the current cursor every 30 s past the browser's copy, and stops once complete` (`packages/client/tests/recorded-day.test.ts`) pins both the cadence and the stop condition. It passes at this commit (`pnpm exec vitest run tests/recorded-day.test.ts` in `packages/client`: 15/15).

### What each request does on the server

Both answers read `day.brokerCodes.codesComplete` (`apps/dashboard/src/server/market-live/recorded-answers.ts:110-122` and `:147-157`). An incomplete day is answered `no-store`. A complete one is answered `private, max-age=60` (`:36`).

`codesComplete` returns the kept value, or runs `status(MAX_SAFE_INTEGER)` when none is kept (`apps/dashboard/src/server/market-live/broker-codes.ts:846-853`). The kept value `keptCodesComplete` is an instance variable (`:620`). It is set by every scan (`:839`) and cleared by every written batch (`:647`). Its Decision says "each status GET scans again", which is true of the extension's status GET. The recorded answers were meant to be free on repeat.

**The cache does not survive the gaps between GETs.** Cloudflare hibernates an object after 10 s with no request or event, if no `setTimeout` or `setInterval` is pending, no outbound I/O is open and no standard-API WebSocket is held. The constructor runs again on the next request ([Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)). A sealed day's object meets those conditions:

- No viewer socket. The Worker sends every viewer and ingest socket to the object of `marketToday` (`apps/dashboard/src/server/market-live/entry.ts:29-41`), not to a recorded day's object.
- No timer. `armFlush` returns once `sealed` (`trading-day.ts:849`), and `checkConditions` stops when there is no viewer (`trading-day.ts:748-767`).
- A recorded GET is plain request and response (`trading-day-object.ts:327-331`).

The two loops' GETs average about 16 s apart, which is longer than the 10 s hibernation threshold. So each GET usually lands on a new instance, built again under `blockConcurrencyWhile` (`trading-day-object.ts:308-315`) with `keptCodesComplete` undefined. It scans once and writes nothing.

### Statements per scan

`status` (`broker-codes.ts:795-841`) pages `broker_code_chunks` 64 chunks at a time (`SCAN_PAGE`, `:80`; a chunk is 1,000 trades, `:33`). For each run of adjacent chunks it calls `unfieldedOf` (`:713-748`):

- `SELECT count(*) FROM trades WHERE number BETWEEN ? AND ?`: one pass over the span's trades.
- Only when the tape lacks a trade in the span: the `lag(number) OVER (ORDER BY number)` pass, which bills again as a window function (#530), then `max(number)`, then the `walk_trades` numbers if `walkRowsHold`.

It ends with `count(*) FROM cross_check_differences` (`:815-820`). On a relay day whose tape is whole, a scan is the `count(*)` passes plus about 1,600 chunk rows: about one row per trade. That matches #532's 1.6 M rows a request.

### Why it starts around 22:00 and ends around 08:00

- **Start.** During the evening walk, batches keep the object awake. Each batch clears the cache and `sweepBrokers.completed` scans at once (see below), so the page's rechecks hit a warm cache or are lost among the batches' scans. When the walk ends (about 22:00 on 11-16), the object idles between rechecks, and every recheck becomes a cold scan. The page could also simply have been opened then. Neither is visible from the code.
- **End.** At 08:40 WIB `/market-live` leaves the recorded day for the live one, and the loops stop. #532's "about 08:00" is the hourly bucket the stop falls in. The extension's walks also stop at 08:40 (`streaming` in `packages/relay/src/schedule.ts:142`), but they aren't the sender (see below).
- **Never `complete`.** The commit message of `83ba334696` records that 2026-11-16 had 4 trades missing that Stockbit's tape lacks. `codesComplete` needs codes for every trade 1..N (`broker-codes.ts:838`), so 11-16 never answers `complete`, and neither loop ends.

### Why it isn't the extension

- **Zero writes.** Every accepted batch writes: `writesOf` does `INSERT OR REPLACE` of each chunk it merged (`broker-codes.ts:584-613`), and a replace bills a row (#530). So no POST is involved, which rules out a re-posted batch, the poster's backoff (`poster.ts:88-116`) and the cross-check.
- **Only the newest object.** Every run asks Production's status of the 9 recent days before the newest (`recentIncomplete`, `run-queue.ts:182-200`). The options page asks all 10 days at once (`apps/extension/src/options/broker-codes-card.tsx:56-75`). Either would put the same plateau on 10 objects, but #532 has 11-12 at only 0.7 B for the whole period.
- **It runs alongside the walks.** On the night of 11-17, the 11-17 plateau held steady while the extension's one run queue (`run-queue.ts:298-308`, one run at a time) was gap-walking 11-16 and then 11-13. Every extension GET comes from inside that sequential run: `walkDay`'s and `gapDay`'s `status` (`stockbit-walk.ts:397-458`), `recentIncomplete`, and the extra target's `behind` (`extra-target.ts:160-169`). The status reader's retry only backs off to 30 s on a failed GET (`status.ts:95-112`). None of them repeats on one day while the queue is walking another.
- **`RETRY_MS`/`RELOAD_MS`** (`ajaib-walk.ts:50-55`) pace Ajaib's own API and tab reloads. They send nothing to the dashboard. The `TICK` (10 s) and the 30 s `tick` alarm (`service-worker.ts:103-108`, `:535-543`) start a run only when a new day becomes the newest closed one (`run-queue.ts:314-324`).

## The bursts

### The request and its loop

After the newest day's walks, each run walks the gaps of every older incomplete day, newest first (`olderDays`, `run-queue.ts:221-245`). `gapDay` (`stockbit-walk.ts:412-458`) asks the day's status, waits for Stockbit's tape (`start`), then runs `forward` from a page below each missing range. Before `83ba334696`, `forward`'s `until` ended a range only when every number in it was seen. A trade Stockbit's tape lacks never comes, so the walk paged on until an empty page: the day's end. The fix adds "or every row of the page is past the range" (`stockbit-walk.ts:435-446`). The commit message puts the old cost at 1,559,660 trades re-paged for 11-16's 4 missing trades. That matches the 11-16 burst from 00:00 to 03:00 WIB on 11-18.

`forward` sends a batch every 10 calls (`CALLS_PER_BATCH`, `stockbit-walk.ts:41-42`, `:351`). The pacer spaces Stockbit calls 334 ms apart (`pacer.ts:40-43`). That gives 3.34 s a batch, or about 1,078 batches an hour at full pace, which is #532's "about 1,100 an hour".

The walk ends `unserved: incomplete` (`stockbit-walk.ts:455-457`). Only `walked` or `no-rows` takes a day off the list (`run-queue.ts:236-242`), and History joins any day it leaves incomplete (`history.ts:84-89`). So the day is walked again on every later run. Runs start on the first tick of each new newest closed day, and also on a broker tab connecting, a settings change, Resume and Run now (`service-worker.ts:553-578`).

### What each batch does on the server

The POST goes through `brokerCodes.post` (`trading-day.ts:1546-1558`):

- `write` merges the rows and replaces the touched chunks. Stockbit agreeing with Ajaib changes no codes, so no index or sweep-broker rows are written (`broker-codes.ts:473-477`, `:630-656`). Writes stay small. `writeFields` reads the batch's span of `trades` (about 1,000 rows, `:559-580`).
- `totalsWritten` (`trading-day.ts:1185-1201`): on a sealed day whose `brokerTotals` fact isn't the current version and has no build wake, it calls `buildable`, which is **one full scan** (`broker-codes.ts:857-861`, not cached). A day that stays unbuildable never gets the wake, so every batch scans.
- `sweepBrokers.completed` (`sweep-brokers.ts:312-322`): on a sealed day, until it once finds the codes complete, it calls `codesComplete`. The batch just cleared the cache, so this is **one full scan**, on every batch of a day that never becomes complete.

So a batch costs 1 or 2 scans. The bursts' 3.4 B rows an hour over about 1,078 batches is about 3.1 M rows a batch, which fits 2 scans of a 1.5–1.6 M-trade day.

## What is unconfirmed

- **That a `/market-live` tab was open overnight**, and on which stock. Workers Logs would settle it. The Worker's request lines for `/market-live/days/2026-11-16/broker-codes?at=…` and `/market-live/days/2026-11-16/sweep-brokers/<code>` between 22:00 and 08:40 WIB should come in pairs about every 32 s, from one session. If the selected code is an index code, there is no sweep loop, and the rate halves to about 112 an hour.
- **That the object hibernates between the GETs.** This follows from Cloudflare's documented conditions, and #532's 1 scan a request implies it. Seeing the constructor run per request (for example, a start log line) would prove it.
- **Whether 11-16's and 11-17's codes are incomplete in Production.** One signed-in GET settles it, using the session cookie from `docs/agents/production-reads.md`: `GET /market-live/days/2026-11-16/broker-codes?at=<epoch ms>`. Read its `complete` field and its `Cache-Control` (`no-store` while incomplete). The extension's `GET /api/broker-codes/2026-11-16` gives `missingCount` too, but it needs the ingest token, not the cookie. Each of these GETs costs one more full scan.
- **Whether #532's 357,526,288 rows an hour is exact for every hour.** It factors as 2⁴ × 7 × 1427 × 2237. If it is exact, the hour held 112 equal cycles of 3,192,199 rows each: two GETs a cycle. That fits the two 30 s loops better than 223 single requests.
- **Whether the bursts run 2 scans a batch.** That depends on each older day's `brokerTotals` fact and build wake, which only the object's facts show.
- **The extension version in the owner's browser on each night.** The walk code changed many times on 11-16 and 11-17 (`git log -- apps/extension/src/worker/broker-codes`). The whole-day re-page is fixed only from 0.0.39 (`83ba334696`). The gap walk still re-asks a day Stockbit can't complete on every run, at 2 status scans plus a small batch per range.
