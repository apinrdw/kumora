// Stockbit's walk of a day (spec apinrdw/kumora#244, "The extension: the
// Stockbit walk"): the day's REST tape forward from trade 1, 100 rows a
// call, on every board. After Ajaib's walk it is the day's cross-check; on a
// day Ajaib can't serve it is the day's only source. Each 10 calls' codes go
// to Production as one batch; `end` follows once a newest-first call agrees.
//
// `forward`, `start` and `finish` are the walk's parts, kept apart so the
// gap walk (cursor over missing ranges) and the History walk reuse them.
import {
  BrokerCodesProtocolVersion,
  MISSING_RANGES,
  TradeNumber,
  stockbitRowCodes,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type TradeCodes,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import type { RequestingTab } from "../pacer.ts"
import {
  CREDENTIAL_COOKIE,
  RUNNING_TRADE_URL,
  stockbitCredential,
} from "../stockbit.ts"
import { inStreamingHours, scheduleNow } from "./hours.ts"
import type { PostOutcome } from "./poster.ts"
import { halt, haltOnRefusal, settle, type WalkResult } from "./run-queue.ts"
import type { StatusOutcome } from "./status.ts"

// Decision: 100 rows a call, Stockbit's most, with `date` and no `symbols`
// or `market_board`, so every board comes back; a batch every 10 calls,
// ~1,000 trades. A whole day 1..1,102,785 took 64 min at 3 calls/s. See
// apinrdw/kumora#127.
const PAGE = 100
const CALLS_PER_BATCH = 10

// Decision: the walk starts once Stockbit answers `is_open_market: false`
// (about 16:58 on 2026-11-11), polling one newest-first call a minute until
// then. A failed call is asked again in place every 10 s while the tab stays
// attached; the pacer has already stopped the site on a throttle. See
// apinrdw/kumora#244, "Stockbit start".
const START_POLL = "1 minute"
const RETRY = "10 seconds"

const TapePage = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      is_open_market: Schema.optionalKey(Schema.Boolean),
      running_trade: Schema.Array(Schema.Unknown),
    }),
  })
)
const RowNumber = Schema.Struct({ trade_number: TradeNumber })
const decodePage = Schema.decodeUnknownOption(TapePage)
const decodeRowNumber = Schema.decodeUnknownOption(RowNumber)

// A row of the tape: its trade number, and its codes when they are valid.
interface TapeRow {
  readonly number: TradeNumber
  readonly value: bigint
  readonly codes: Option.Option<TradeCodes>
}

interface Page {
  // `is_open_market`; undefined when the answer leaves it out.
  readonly open: boolean | undefined
  // In Stockbit's order: by time, and within a second not by trade number.
  readonly rows: ReadonlyArray<TapeRow>
}

// Where a forward walk ended: the highest trade number it saw (or started
// from), and the last row Stockbit sent, which the next page pages after.
interface Walked {
  readonly highest: bigint
  readonly cursor: Option.Option<TradeNumber>
}

const tapeUrl = (
  day: WibDate,
  query:
    | { readonly sort: "ASC"; readonly cursor: Option.Option<TradeNumber> }
    | { readonly sort: "DESC" }
) =>
  Effect.sync(() => {
    const params = new URLSearchParams({
      sort: query.sort,
      order_by: "RUNNING_TRADE_ORDER_BY_TIME",
      limit: query.sort === "ASC" ? String(PAGE) : "1",
      date: day,
    })
    if (query.sort === "ASC" && Option.isSome(query.cursor))
      params.set("trade_number", query.cursor.value)
    return `${RUNNING_TRADE_URL}?${params}`
  })

// A page's rows that carry a trade number; a row without one is skipped.
const pageOf = Effect.fnUntraced(function* (body: string) {
  const page = decodePage(body)
  if (Option.isNone(page)) return Option.none<Page>()
  const rows: Array<TapeRow> = []
  for (const raw of page.value.data.running_trade) {
    const row = decodeRowNumber(raw)
    if (Option.isNone(row)) continue
    const number = row.value.trade_number
    rows.push({
      number,
      value: BigInt(number),
      codes: yield* stockbitRowCodes(raw),
    })
  }
  return Option.some<Page>({ open: page.value.data.is_open_market, rows })
})

// Where a forward walk stands after a page: its highest number and the
// page's last row. None for an empty page, which ends the walk.
const walkedPast = Effect.fnUntraced(function* (
  walked: Walked,
  rows: ReadonlyArray<TapeRow>
) {
  const last = rows.at(-1)
  if (last === undefined) return Option.none<Walked>()
  const highest = rows.reduce(
    (max, row) => (row.value > max ? row.value : max),
    walked.highest
  )
  return Option.some<Walked>({ highest, cursor: Option.some(last.number) })
})

// The highest trade number the day's status shows Stockbit reached; none to
// start from trade 1, or "done" when the walk has nothing left to do: the
// cross-check is compared, or Stockbit alone made the day complete.
const resumeFrom = Effect.fnUntraced(function* (status: BrokerCodesStatus) {
  const { crossCheck } = status
  if (crossCheck.state === "compared") return "done" as const
  if (crossCheck.state === "pending")
    return crossCheck.walkedTo === "0"
      ? Option.none<TradeNumber>()
      : Option.some(crossCheck.walkedTo)
  if (status.complete) return "done" as const
  return yield* highestHeld(status)
})

// Stockbit's walk alone: the highest trade held, from a status that lists
// from trade 1. While n is unknown, every trade up to it is held or missing.
// Once n is known, a list that ends at n names the missing tail; a list cut
// short at MISSING_RANGES may end before it, so the walk resumes after the
// last range listed, a trade held, and walks the rest again.
const highestHeld = Effect.fnUntraced(function* (status: BrokerCodesStatus) {
  let listed = 0n
  for (const [from, to] of status.missing)
    listed += BigInt(to) - BigInt(from) + 1n
  const last = status.missing.at(-1)
  let top =
    status.n === null
      ? BigInt(status.sources.ajaib + status.sources.stockbit) +
        BigInt(status.missingCount)
      : BigInt(status.n)
  if (status.n !== null && last !== undefined)
    if (listed < BigInt(status.missingCount)) top = BigInt(last[1]) + 1n
    else if (BigInt(last[1]) === top) top = BigInt(last[0]) - 1n
  return top > 0n
    ? Option.some(TradeNumber.make(top.toString()))
    : Option.none<TradeNumber>()
})

// The walk's paced calls, and whether the Stockbit tab is still there.
type WalkTab = RequestingTab & { readonly attached: Effect.Effect<boolean> }

export const makeStockbitWalk = Effect.fnUntraced(function* (options: {
  readonly tab: WalkTab
  readonly post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  // The day's status on Production, listing the missing ranges after
  // `after`, from trade 1 when it is left out.
  readonly status: (
    day: WibDate,
    after?: TradeNumber
  ) => Effect.Effect<StatusOutcome>
  // For the options page (progress.ts): the highest trade walked of the
  // day's N once known, and the wait on a signed-out tab.
  readonly trades?: (
    fetched: number,
    of: Option.Option<number>
  ) => Effect.Effect<void>
  readonly signedOut?: (out: boolean) => Effect.Effect<void>
}) {
  const { tab } = options
  const trades = options.trades ?? (() => Effect.void)
  const signedOut = options.signedOut ?? (() => Effect.void)
  // The day's N, as the newest row the walk's start saw.
  let dayN = Option.none<number>()

  const guard = Effect.gen(function* () {
    if (yield* inStreamingHours(yield* scheduleNow))
      return yield* halt({ _tag: "stopped", cause: "streaming-hours" })
  })

  // The credential cookie's value; a tab that doesn't answer stops the walk
  // until a Stockbit tab connects.
  const cookie = Effect.gen(function* () {
    const answer = yield* tab.request({
      _tag: "cookie",
      name: CREDENTIAL_COOKIE,
    })
    if (Option.isNone(answer))
      return yield* halt({ _tag: "stopped", cause: "no-tab" })
    return answer.value.body
  })

  // Decision: on a 401, or a cookie with no token, the walk waits in place
  // until the tab's `credentialStorage` cookie changes; the extension never
  // signs in itself. The wait shows as "Stockbit signed out" until it ends.
  // See apinrdw/kumora#244, "A 401".
  const awaitNewCookie = (stale: string) =>
    Effect.ensuring(
      Effect.andThen(
        signedOut(true),
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(RETRY)
            yield* guard
            if ((yield* cookie) !== stale) return
          }
        })
      ),
      signedOut(false)
    )

  // One call, asked again in place until it answers a page.
  const call = Effect.fnUntraced(function* (url: string) {
    while (true) {
      yield* guard
      const held = yield* cookie
      const credential = yield* stockbitCredential(held)
      if (Option.isNone(credential)) {
        yield* awaitNewCookie(held)
        continue
      }
      const answer = yield* tab.request({
        _tag: "fetch",
        url,
        headers: { authorization: `Bearer ${credential.value.accessToken}` },
      })
      if (Option.isNone(answer)) {
        if (!(yield* tab.attached))
          return yield* halt({ _tag: "stopped", cause: "no-tab" })
        yield* Effect.sleep(RETRY)
        continue
      }
      if (answer.value.status === 401) {
        yield* awaitNewCookie(held)
        continue
      }
      if (answer.value.status === 200) {
        const page = yield* pageOf(answer.value.body)
        if (Option.isSome(page)) return page.value
      }
      yield* Effect.sleep(RETRY)
    }
  })

  const post = Effect.fnUntraced(function* (
    batch: Omit<BrokerCodesBatch, "version" | "feed">
  ) {
    const outcome = yield* options.post({
      version: BrokerCodesProtocolVersion,
      feed: "Stockbit",
      ...batch,
    })
    if (outcome !== "sent") return yield* haltOnRefusal(outcome)
  })

  // Waits for Stockbit to close the day, then answers the tape's newest row;
  // a day with no rows is given up.
  const start = Effect.fnUntraced(function* (day: WibDate) {
    const url = yield* tapeUrl(day, { sort: "DESC" })
    while (true) {
      const page = yield* call(url)
      if (page.open === false) {
        const newest = page.rows[0]
        if (newest === undefined)
          return yield* halt({ _tag: "unserved", reason: "no-rows" })
        dayN = Option.some(Number(newest.value))
        return newest
      }
      yield* Effect.sleep(START_POLL)
    }
  })

  // Pages forward after `from` (none: from trade 1) until a page comes back
  // empty, or `until` says the page just read was the last one needed. Each
  // 10 calls' valid codes go up as one batch, and what is held goes up when
  // the walk ends or stops.
  const forward = Effect.fnUntraced(function* (
    day: WibDate,
    from: Option.Option<TradeNumber>,
    until: (rows: ReadonlyArray<TapeRow>) => boolean = () => false
  ) {
    let walked: Walked = {
      highest: Option.match(from, { onNone: () => 0n, onSome: BigInt }),
      cursor: from,
    }
    let held = new Map<TradeNumber, TradeCodes>()
    let calls = 0
    const flush = Effect.suspend(() => {
      const rows = [...held]
      held = new Map()
      calls = 0
      return rows.length === 0 ? Effect.void : post({ day, rows })
    })
    const pages = Effect.gen(function* () {
      while (true) {
        const page = yield* call(
          yield* tapeUrl(day, { sort: "ASC", cursor: walked.cursor })
        )
        const next = yield* walkedPast(walked, page.rows)
        if (Option.isNone(next)) return
        walked = next.value
        yield* trades(Number(walked.highest), dayN)
        for (const row of page.rows)
          if (row.value > 0n && Option.isSome(row.codes))
            held.set(row.number, row.codes.value)
        if (++calls >= CALLS_PER_BATCH) yield* flush
        if (until(page.rows)) return
      }
    })
    yield* Effect.catchTag(pages, "Halt", (stop) =>
      Effect.andThen(flush, Effect.fail(stop))
    )
    yield* flush
    return walked
  })

  // Decision: a forward walk that reached an empty page ends once one
  // newest-first call shows no trade past it, and posts `end` with the
  // highest number it saw. A tape that grew past the walk is walked on.
  // See apinrdw/kumora#244, "Stockbit `end`".
  const finish = Effect.fnUntraced(function* (day: WibDate, from: Walked) {
    let walked = from
    while (true) {
      const head = yield* call(yield* tapeUrl(day, { sort: "DESC" }))
      const newest = head.rows[0]
      if (newest === undefined || newest.value <= walked.highest) break
      const more = yield* forward(day, walked.cursor)
      if (more.highest === walked.highest) yield* Effect.sleep(START_POLL)
      walked = more
    }
    if (walked.highest === 0n)
      return yield* halt({ _tag: "unserved", reason: "no-rows" })
    yield* post({
      day,
      rows: [],
      end: { n: TradeNumber.make(walked.highest.toString()) },
    })
  })

  // The day's status on Production; a refusal stops the walk.
  const status = Effect.fnUntraced(function* (
    day: WibDate,
    after?: TradeNumber
  ) {
    const outcome = yield* options.status(day, after)
    if (typeof outcome === "string") return yield* haltOnRefusal(outcome)
    return outcome
  })

  // The full walk: forward from trade 1, or from where the day's status
  // shows Stockbit reached, to the day's end.
  const walkDay = Effect.fnUntraced(function* (day: WibDate) {
    dayN = Option.none()
    yield* guard
    const from = yield* resumeFrom(yield* status(day))
    if (from === "done") return { _tag: "walked" } satisfies WalkResult
    yield* start(day)
    yield* finish(day, yield* forward(day, from))
    return { _tag: "walked" } satisfies WalkResult
  })

  // The gap walk of an older incomplete day: each missing range from a page
  // below it, until every number in it was seen, a status's list at a time,
  // each asked after the last range the one before listed; then, while the
  // day's end isn't known, on from the highest trade held to the end.
  // Walked once the day's status is complete.
  const gapDay = Effect.fnUntraced(function* (day: WibDate) {
    dayN = Option.none()
    yield* guard
    const before = yield* status(day)
    if (before.complete) return { _tag: "walked" } satisfies WalkResult
    yield* start(day)
    let listed = before.missing
    while (true) {
      for (const [from, to] of listed) {
        const low = BigInt(from)
        const high = BigInt(to)
        const seen = new Set<bigint>()
        // Decision: a range's walk pages after the trade a page (100) below
        // it, not the one just below: within a second Stockbit sends trades
        // out of number order, so a range's first trade can come before the
        // one below it. A trade seen without codes counts as seen, since it
        // comes only once a walk. See apinrdw/kumora#244, "Gap walk".
        const below = low - 1n - BigInt(PAGE)
        yield* forward(
          day,
          below > 0n
            ? Option.some(TradeNumber.make(below.toString()))
            : Option.none(),
          (rows) => {
            for (const row of rows)
              if (row.value >= low && row.value <= high) seen.add(row.value)
            return BigInt(seen.size) === high - low + 1n
          }
        )
      }
      const last = listed.at(-1)
      if (last === undefined || listed.length < MISSING_RANGES) break
      listed = (yield* status(day, last[1])).missing
    }
    if (before.n === null)
      yield* finish(day, yield* forward(day, yield* highestHeld(before)))
    return (yield* status(day)).complete
      ? ({ _tag: "walked" } satisfies WalkResult)
      : ({ _tag: "unserved", reason: "incomplete" } satisfies WalkResult)
  })

  return {
    walk: (day: WibDate): Effect.Effect<WalkResult> => settle(walkDay(day)),
    gaps: (day: WibDate): Effect.Effect<WalkResult> => settle(gapDay(day)),
    start,
    forward,
    finish,
    status,
  }
})

// Decision: the extra target's Stockbit catch-up (extra-target.ts) is the
// gap walk over the extra target's own status, so it fills the holes inside
// the day too, not just the tail. A status the extra target didn't give
// stops the walk as an unset token would, which ends only the catch-up. See
// apinrdw/kumora#251.
export const stockbitCatchUp = Effect.fnUntraced(function* (options: {
  readonly tab: WalkTab
  readonly post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  readonly status: (
    day: WibDate,
    after?: TradeNumber
  ) => Effect.Effect<Option.Option<BrokerCodesStatus>>
  readonly signedOut?: (out: boolean) => Effect.Effect<void>
}) {
  const walk = yield* makeStockbitWalk({
    tab: options.tab,
    post: options.post,
    ...(options.signedOut === undefined
      ? {}
      : { signedOut: options.signedOut }),
    status: (day, after) =>
      Effect.map(
        options.status(day, after),
        Option.getOrElse((): StatusOutcome => "off")
      ),
  })
  return { walk: walk.gaps }
})
