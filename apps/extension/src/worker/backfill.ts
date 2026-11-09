// Backfill: the trade numbers a trading-day object asked for, fetched from
// the brokers' REST running-trade tapes (spec apinrdw/kumora#138, "Backfill").
// Stockbit first, by trade-number cursor; what it leaves goes to Ajaib, by
// time, once Ajaib's REST tape has caught up. Pages go up raw: the Worker
// decodes them and keeps the rows it lacks.
import {
  IngestProtocolVersion,
  TradeNumber,
  TradeNumberValue,
  tradeNumberValue,
  type Feed,
  type IngestDown,
  type IngestUp,
} from "@workspace/relay"
import { Clock, DateTime, Effect, Option, Schema } from "effect"

import type { Answer, TabRequest } from "./broker.ts"
import type { TargetName } from "./settings.ts"
import { RUNNING_TRADE_URL, tabCredential } from "./stockbit.ts"

// What backfill needs of a broker tab (tab.ts).
interface RequestingTab {
  readonly request: (
    request: TabRequest
  ) => Effect.Effect<Option.Option<Answer>>
}

// Decision: each site gets about one REST call a second, the pace
// apinrdw/kumora#61 set until the brokers' limits are measured: Stockbit's
// Cloudflare answers a burst with a challenge no content script can solve.
const CALL_INTERVAL = "1 second"

// Stockbit's REST tape answers at most 100 rows a call. Gaps this close
// share a call, so they are fetched as one range.
const STOCKBIT_PAGE = 100n

// Decision: Ajaib's REST tape runs about 2 minutes behind (apinrdw/kumora#48),
// so a range reaches Ajaib no sooner than 2 minutes after its next trade, and
// pages of 40, the size Ajaib's own web app asks for (its cap is unmeasured).
const AJAIB_LAG = 120_000
const AJAIB_PAGE_SIZE = 40

// A range to fetch and who asked for it. `nextTime` is when trade `to` + 1
// happened, in epoch ms.
interface Job {
  readonly from: TradeNumberValue
  readonly to: TradeNumberValue
  readonly nextTime: number
  readonly targets: ReadonlySet<TargetName>
  // Paging: Stockbit's cursor, or Ajaib's next page.
  readonly cursor: TradeNumberValue
  readonly page: number
  // The numbers in the range the pages so far carried.
  readonly covered: ReadonlySet<TradeNumberValue>
}

const StockbitNumbers = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      running_trade: Schema.Array(
        Schema.Struct({
          trade_number: TradeNumber,
        })
      ),
    }),
  })
)
const AjaibNumbers = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        trade_num: Schema.String.check(Schema.isPattern(/^\d{18}$/)),
      })
    ),
    has_next: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  })
)
const decodeStockbit = Schema.decodeUnknownOption(StockbitNumbers)
const decodeAjaib = Schema.decodeUnknownOption(AjaibNumbers)

// The trade numbers on one page, as bare daily sequences, and whether the
// broker has more pages after it. None when the body isn't a page.
interface PageNumbers {
  readonly numbers: ReadonlyArray<TradeNumberValue>
  readonly more: boolean
}
const numbersOn = Effect.fnUntraced(function* (feed: Feed, body: string) {
  if (feed === "Stockbit") {
    const page = decodeStockbit(body)
    if (Option.isNone(page)) return Option.none<PageNumbers>()
    const numbers = yield* Effect.forEach(
      page.value.data.running_trade,
      (row) => tradeNumberValue(row.trade_number)
    )
    return Option.some<PageNumbers>({ numbers, more: true })
  }
  const page = decodeAjaib(body)
  if (Option.isNone(page)) return Option.none<PageNumbers>()
  const numbers = yield* Effect.forEach(page.value.results, (row) =>
    tradeNumberValue(TradeNumber.make(row.trade_num.slice(8)))
  )
  return Option.some<PageNumbers>({
    numbers,
    more: page.value.has_next === true,
  })
})

// A GET from the Stockbit tab with its own bearer token; none without one.
const bearerFetch = Effect.fnUntraced(function* (
  tab: RequestingTab,
  url: string
) {
  const credential = yield* tabCredential(tab)
  if (Option.isNone(credential)) return Option.none<Answer>()
  return yield* tab.request({
    _tag: "fetch",
    url,
    headers: { authorization: `Bearer ${credential.value.accessToken}` },
  })
})

const fresh = Effect.fnUntraced(function* (
  range: Pick<Job, "from" | "to" | "nextTime" | "targets">
) {
  const job: Job = {
    ...range,
    cursor: TradeNumberValue.make(range.to + 1n),
    page: 1,
    covered: new Set(),
  }
  return job
})

// The runs of numbers in the job's range that no page carried.
const uncovered = Effect.fnUntraced(function* (job: Job) {
  const runs: Array<{ from: TradeNumberValue; to: TradeNumberValue }> = []
  for (
    let number = job.from;
    number <= job.to;
    number = TradeNumberValue.make(number + 1n)
  ) {
    if (job.covered.has(number)) continue
    const last = runs.at(-1)
    if (last !== undefined && last.to === number - 1n) last.to = number
    else runs.push({ from: number, to: number })
  }
  return runs
})

// Adds a range to a site's queue, merged into a queued one it overlaps or
// sits next to, whichever target asked: every page goes to every target.
const enqueue = Effect.fnUntraced(function* (
  queue: Array<Job>,
  job: Job,
  slack: bigint
) {
  const sharesACall = (held: Job) =>
    held.from <= job.to + slack && job.from <= held.to + slack
  const merged = queue.filter(sharesACall)
  const kept = queue.filter((held) => !sharesACall(held))
  const all = [...merged, job]
  const to = all.reduce((max, each) => (each.to > max.to ? each : max))
  kept.push(
    yield* fresh({
      from: all.reduce(
        (min, each) => (each.from < min ? each.from : min),
        job.from
      ),
      to: to.to,
      nextTime: to.nextTime,
      targets: new Set(all.flatMap((each) => [...each.targets])),
    })
  )
  return kept
})

// Decision: Production's ranges are fetched first; a range only the extra
// target asked for waits for a spare call. See apinrdw/kumora#134.
const takeNext = Effect.fnUntraced(function* (
  queue: Array<Job>,
  ready: (job: Job) => boolean
) {
  const eligible = queue.filter(ready)
  const job =
    eligible.find((each) => each.targets.has("production")) ?? eligible[0]
  if (job !== undefined) queue.splice(queue.indexOf(job), 1)
  return job
})

export const makeBackfill = Effect.fnUntraced(function* (options: {
  readonly stockbit: RequestingTab
  readonly ajaib: RequestingTab
  readonly publish: (message: IngestUp) => Effect.Effect<unknown>
}) {
  let stockbitQueue: Array<Job> = []
  let ajaibQueue: Array<Job> = []

  // A target's object asked for a range.
  const request = Effect.fnUntraced(function* (
    target: TargetName,
    message: Extract<IngestDown, { _tag: "Backfill" }>
  ) {
    const from = yield* tradeNumberValue(message.from)
    const to = yield* tradeNumberValue(message.to)
    if (to < from) return
    stockbitQueue = yield* enqueue(
      stockbitQueue,
      yield* fresh({
        from,
        to,
        nextTime: DateTime.toEpochMillis(message.nextTime),
        targets: new Set([target]),
      }),
      STOCKBIT_PAGE
    )
  })

  // What Stockbit left goes to Ajaib, run by run.
  const fallBack = Effect.fnUntraced(function* (job: Job) {
    for (const run of yield* uncovered(job))
      ajaibQueue = yield* enqueue(
        ajaibQueue,
        yield* fresh({ ...job, ...run }),
        0n
      )
  })

  const send = Effect.fnUntraced(function* (
    feed: Feed,
    job: Job,
    body: string
  ) {
    yield* options.publish({
      _tag: "BackfillPage",
      protocolVersion: IngestProtocolVersion,
      feed,
      receivedAt: yield* DateTime.now,
      from: TradeNumber.make(job.from.toString()),
      to: TradeNumber.make(job.to.toString()),
      body,
    })
  })

  // The job after one page: done, or paged on from the page's oldest number.
  const after = Effect.fnUntraced(function* (
    job: Job,
    numbers: ReadonlyArray<TradeNumberValue>
  ) {
    const covered = new Set(job.covered)
    for (const number of numbers)
      if (number >= job.from && number <= job.to) covered.add(number)
    const oldest = numbers.reduce(
      (min, number) => (number < min ? number : min),
      job.cursor
    )
    return { ...job, covered, cursor: oldest, page: job.page + 1 }
  })

  // One Stockbit call: the page before the job's cursor, newest first.
  const stockbitCall = Effect.fnUntraced(function* () {
    const job = yield* takeNext(stockbitQueue, () => true)
    if (job === undefined) return false
    const url = `${RUNNING_TRADE_URL}?sort=DESC&order_by=RUNNING_TRADE_ORDER_BY_TIME&limit=${STOCKBIT_PAGE}&trade_number=${job.cursor}`
    const answer = yield* bearerFetch(options.stockbit, url)
    const ok = Option.filter(answer, (received) => received.status === 200)
    const page = Option.isNone(ok)
      ? Option.none<{
          numbers: ReadonlyArray<TradeNumberValue>
          body: string
        }>()
      : Option.map(yield* numbersOn("Stockbit", ok.value.body), (found) => ({
          ...found,
          body: ok.value.body,
        }))
    if (Option.isNone(page)) {
      yield* fallBack(job)
      return true
    }
    yield* send("Stockbit", job, page.value.body)
    const next = yield* after(job, page.value.numbers)
    const progressed = next.cursor < job.cursor
    if (
      progressed &&
      next.cursor > job.from &&
      (yield* uncovered(next)).length > 0
    )
      stockbitQueue.unshift(next)
    else yield* fallBack(next)
    return true
  })

  // One Ajaib call: a page of the tape at the job's next trade's time.
  const ajaibCall = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis
    const job = yield* takeNext(
      ajaibQueue,
      (each) => each.nextTime + AJAIB_LAG <= now
    )
    if (job === undefined) return false
    // Ajaib rounds its times to the second.
    const lastTimestamp = job.nextTime + 1000
    const path = `v1/stock/detail/running_trades/?direction=DESC&last_timestamp=${lastTimestamp}&page=${job.page}&page_size=${AJAIB_PAGE_SIZE}`
    const answer = yield* options.ajaib.request({ _tag: "page-fetch", path })
    if (Option.isNone(answer) || answer.value.status !== 200) return true
    const found = yield* numbersOn("Ajaib", answer.value.body)
    if (Option.isNone(found)) return true
    yield* send("Ajaib", job, answer.value.body)
    const next = yield* after(job, found.value.numbers)
    // A range Ajaib can't fill either stays unfilled.
    if (
      found.value.more &&
      found.value.numbers.length > 0 &&
      next.cursor > job.from &&
      (yield* uncovered(next)).length > 0
    )
      ajaibQueue.unshift(next)
    return true
  })

  // Each site calls at most once per interval, forever.
  const pace = (call: Effect.Effect<boolean>) =>
    Effect.forever(
      Effect.andThen(
        Effect.catchCause(call, (cause) =>
          Effect.as(Effect.logError("Backfill call failed", cause), true)
        ),
        Effect.sleep(CALL_INTERVAL)
      )
    )
  const run = Effect.all([pace(stockbitCall()), pace(ajaibCall())], {
    concurrency: "unbounded",
    discard: true,
  })

  return { request, run }
})
