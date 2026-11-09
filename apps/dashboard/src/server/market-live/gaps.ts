// Gap detection on the merged tape (spec apinrdw/kumora#138, "Merge and
// dedupe" and "Backfill"): a trade number still missing 5 s after a later
// number arrived is asked for down every ready ingest socket, once. What the
// relay can't fill stays missing, silently.
import {
  TradeNumber,
  encodeIngestDown,
  type RunningTrade,
} from "@workspace/relay"
import type { DateTime } from "effect"
import { Clock, Duration, Effect, Scope } from "effect"

// What this needs of an ingest socket (trading-day.ts's Peer).
interface IngestPeer {
  readonly send: (text: string) => Effect.Effect<void>
  readonly state: Effect.Effect<"new" | "ready">
}

// The merge window: Ajaib arrives about 1 s behind Stockbit and out of order,
// so a number is a gap only once it has had this long to arrive.
const GAP_WAIT = 5_000

// Decision: a gap wider than 10,000 numbers is asked for only its newest
// 10,000. A wider one means the relay was away for minutes, and the relay
// fetches about 100 rows a call at about one call a second (the extension's
// backfill.ts), so the newest 10,000 already take its budget for minutes.
const WIDEST_GAP = 10_000n

// A run of missing numbers, not asked for yet.
interface Missing {
  readonly from: bigint
  readonly to: bigint
  // When trade `to` + 1 happened, and when it arrived.
  readonly nextTime: DateTime.Utc
  readonly since: number
}

export const makeGaps = Effect.fnUntraced(function* (options: {
  // Every ingest socket the object holds, ready or not.
  readonly ingests: Effect.Effect<ReadonlyArray<IngestPeer>>
  // The highest number the day stored before the object restarted.
  readonly highest?: bigint | undefined
}) {
  const scope = yield* Scope.Scope
  // Decision: the day's first number starts the count, and nothing below it is
  // a gap. A restarted object counts on from the highest number it stored, so
  // what the relay sent while it was down is a gap.
  let highest: bigint | undefined = options.highest
  let missing: Array<Missing> = []
  let checkScheduled = false

  // A trade arrived: a jump past the highest number opens a gap, and a number
  // inside a gap closes its part of it.
  const seen = Effect.fnUntraced(function* (trade: RunningTrade) {
    const number = BigInt(trade.tradeNumber)
    if (highest === undefined || number > highest) {
      if (highest !== undefined && number > highest + 1n) {
        const from = highest + 1n
        missing.push({
          from: number - from > WIDEST_GAP ? number - WIDEST_GAP : from,
          to: number - 1n,
          nextTime: trade.time,
          since: yield* Clock.currentTimeMillis,
        })
      }
      highest = number
      return
    }
    missing = missing.flatMap((gap) =>
      number < gap.from || number > gap.to
        ? [gap]
        : [
            { ...gap, to: number - 1n, nextTime: trade.time },
            { ...gap, from: number + 1n },
          ].filter((part) => part.from <= part.to)
    )
  })

  const request = Effect.fnUntraced(function* (now: number) {
    const due = missing.filter((gap) => gap.since + GAP_WAIT <= now)
    missing = missing.filter((gap) => gap.since + GAP_WAIT > now)
    if (due.length === 0) return
    const ready: Array<IngestPeer> = []
    for (const peer of yield* options.ingests)
      if ((yield* peer.state) === "ready") ready.push(peer)
    for (const gap of due) {
      const text = yield* encodeIngestDown({
        _tag: "Backfill",
        from: TradeNumber.make(gap.from.toString()),
        to: TradeNumber.make(gap.to.toString()),
        nextTime: gap.nextTime,
      })
      for (const peer of ready) yield* peer.send(text)
    }
  })

  // Asks for each gap once its wait is over, on one timer.
  const schedule: Effect.Effect<void> = Effect.gen(function* () {
    if (checkScheduled || missing.length === 0) return
    checkScheduled = true
    const now = yield* Clock.currentTimeMillis
    const next = Math.min(...missing.map((gap) => gap.since + GAP_WAIT))
    yield* Effect.sleep(Duration.millis(Math.max(0, next - now))).pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap(request),
      Effect.ensuring(
        Effect.sync(() => {
          checkScheduled = false
        })
      ),
      Effect.andThen(Effect.suspend(() => schedule)),
      Effect.catchCause((cause) =>
        Effect.logError("Backfill not requested", cause)
      ),
      Effect.forkIn(scope)
    )
  })

  return { seen, schedule }
})
