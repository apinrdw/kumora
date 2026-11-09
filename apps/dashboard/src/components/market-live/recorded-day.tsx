// A recorded day at its close (spec apinrdw/kumora#138, "Closed market and
// recorded days"): the day's GETs fill the same stores the viewer socket
// fills live, so the chart, watchlist, order book and tape render unchanged.
import {
  clientRuntime,
  fetchRecordedBook,
  fetchRecordedCandles,
  fetchRecordedGaps,
  fetchRecordedTape,
} from "@workspace/client"
import type {
  MarketPhase,
  RelayGap,
  StockCode,
  ViewerDown,
  WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Fiber, Option, Predicate } from "effect"
import type { HttpClient } from "effect/http/HttpClient"
import { useEffect, useState } from "react"

import { KStatusPill } from "@/components/k/status-pill"
import { dayLabel } from "@/lib/format"
import { closeOf, dayStateAt } from "@/lib/recorded-day"

import type { CandleStore } from "./candle-store"
import type { DayStateStore } from "./day-state-store"
import { TAPE_HEIGHT, TapeSection } from "./live-tape"
import { PhaseLabel } from "./market-status"
import type { OrderBookStore } from "./order-book-store"
import { signInAgain } from "./sign-in-again"
import { TapeList, useFramedTape } from "./tape-list"

type Delta = Extract<ViewerDown, { readonly _tag: "Delta" }>

// What a recorded load adds to a store, in the socket's words: a delta onto
// the day's fresh stores.
const recordedDelta = (parts: Partial<Omit<Delta, "_tag">>): ViewerDown => ({
  _tag: "Delta",
  tape: [],
  candles: [],
  ...parts,
})

// Runs a load until the effect that started it cleans up; a 401 sends the
// visitor to sign in.
const runLoad = (load: Effect.Effect<void, unknown, HttpClient>) => {
  const fiber = clientRuntime.runFork(
    load.pipe(
      Effect.catchIf(
        (error) => Predicate.isTagged(error, "SignInRequired"),
        () => signInAgain
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Recorded day not loaded", cause)
      )
    )
  )
  return () => {
    clientRuntime.runFork(Fiber.interrupt(fiber))
  }
}

// The selected code's whole-day candles and its book frame at the close.
const loadSelected = (
  day: WibDate,
  selected: StockCode,
  candles: CandleStore,
  book: OrderBookStore
) =>
  Effect.gen(function* () {
    const answer = yield* fetchRecordedCandles(day, selected)
    if (Option.isSome(answer))
      candles.apply(recordedDelta({ candles: answer.value.candles }))
    const frame = yield* fetchRecordedBook(day, selected, closeOf(day))
    if (frame !== undefined) book.apply(recordedDelta({ orderBooks: [frame] }))
  })

// Each watchlist code's row at the close, worked out from its candles.
const loadWatchlist = (
  day: WibDate,
  watchlist: ReadonlyArray<StockCode>,
  dayStates: DayStateStore
) =>
  Effect.gen(function* () {
    const answers = yield* Effect.forEach(
      watchlist,
      (code) => fetchRecordedCandles(day, code),
      { concurrency: 4 }
    )
    const states = answers.flatMap((answer) => {
      if (Option.isNone(answer)) return []
      const state = dayStateAt(answer.value, closeOf(day))
      return state === undefined ? [] : [state]
    })
    dayStates.apply(recordedDelta({ dayStates: states }))
  })

// The newest 200 trades at the close, then the day's relay gaps.
const loadTape = (
  day: WibDate,
  apply: (message: ViewerDown) => void,
  setGaps: (gaps: ReadonlyArray<RelayGap>) => void
) =>
  Effect.gen(function* () {
    const trades = yield* fetchRecordedTape(day, closeOf(day))
    apply(recordedDelta({ tape: trades }))
    const gaps = yield* fetchRecordedGaps(day)
    setGaps(gaps)
  })

/**
 * Fills the stores with `day` at its close, when there is one: the selected
 * code's whole-day candles and its book frame in force, and each watchlist
 * code's row.
 */
export function useRecordedDay({
  day,
  selected,
  watchlist,
  candles,
  book,
  dayStates,
}: {
  day: WibDate | undefined
  selected: StockCode
  watchlist: ReadonlyArray<StockCode>
  candles: CandleStore
  book: OrderBookStore
  dayStates: DayStateStore
}) {
  useEffect(() => {
    if (day === undefined) return
    return runLoad(loadSelected(day, selected, candles, book))
  }, [day, selected, candles, book])
  useEffect(() => {
    if (day === undefined) return
    return runLoad(loadWatchlist(day, watchlist, dayStates))
  }, [day, watchlist, dayStates])
}

const NO_GAPS: ReadonlyArray<RelayGap> = []

// The day's newest 200 trades at its close, with its relay gaps.
export function RecordedTape({
  day,
  selected,
  onSelect,
}: {
  day: WibDate
  selected: StockCode
  onSelect: (code: StockCode) => void
}) {
  const { tape, frame, apply } = useFramedTape()
  const [gaps, setGaps] = useState(NO_GAPS)
  useEffect(() => runLoad(loadTape(day, apply, setGaps)), [day, apply])
  return (
    <TapeSection>
      <TapeList
        tape={tape}
        frame={frame}
        selected={selected}
        onSelect={onSelect}
        gaps={gaps}
        className={TAPE_HEIGHT}
      />
    </TapeSection>
  )
}

// A recorded day's header status: the RECORDED pill in place of the feed
// pills and the day shown; while the market is shut, its phase and next open.
export function RecordedStatusBar({
  day,
  closed,
}: {
  day: WibDate
  closed?:
    | { readonly phase: MarketPhase; readonly nextOpen?: number }
    | undefined
}) {
  return (
    <div
      role="group"
      aria-label="Market status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]"
    >
      <KStatusPill status="recorded" />
      <span aria-label="Day shown" className="font-medium">
        {dayLabel(day)}
        <span className="font-normal text-muted-foreground">
          {" "}
          · at the close
        </span>
      </span>
      {closed !== undefined && (
        <PhaseLabel
          phase={closed.phase}
          nextOpen={
            closed.nextOpen === undefined
              ? undefined
              : DateTime.makeUnsafe(closed.nextOpen)
          }
        />
      )}
    </div>
  )
}
