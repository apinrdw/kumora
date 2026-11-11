// A recorded day at its replay cursor (spec apinrdw/kumora#138, "Closed
// market and recorded days", "Recorded day loads"): the day's GETs fill the
// same stores the viewer socket fills live, so the chart, watchlist, order
// book and tape render unchanged, each read as of the cursor.
import {
  clientRuntime,
  fetchRecordedBookChunk,
  fetchRecordedCandles,
  fetchRecordedGaps,
  fetchRecordedTape,
} from "@workspace/client"
import {
  bookAt,
  marketPhases,
  type BookChunk,
  type MarketPhase,
  type RecordedCandles,
  type RelayGap,
  type RunningTrade,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Fiber, Option, Predicate } from "effect"
import type { HttpClient } from "effect/http/HttpClient"
import { useEffect, useMemo, useState } from "react"

import { KStatusPill } from "@/components/k/status-pill"
import { dayLabel, tapeTime } from "@/lib/format"
import { dayStateAt } from "@/lib/recorded-day"
import { TAPE_INTERVAL_MS, gapAt, replayDay, tapeInstant } from "@/lib/replay"

import type { CandleStore } from "./candle-store"
import type { DayStateStore } from "./day-state-store"
import { TAPE_HEIGHT, TapeSection } from "./live-tape"
import { PhaseLabel } from "./market-conditions"
import { OrderBookPanel } from "./order-book-panel"
import type { OrderBookStore } from "./order-book-store"
import { makeReplayCursor, useReplay, type ReplayCursor } from "./replay-cursor"
import { signInAgain } from "./sign-in-again"
import { TapeList, useFramedTape } from "./tape-list"

const MINUTE = 60_000
// Decision: the book frame follows the cursor in quarter seconds, the
// relay's book delta cadence; finer redraws would show the same frame.
const BOOK_STEP_MS = 250

// The loads one effect started, each stopped when the effect cleans up; a
// 401 sends the visitor to sign in.
function makeLoads() {
  const fibers = new Set<Fiber.Fiber<void>>()
  return {
    run: (load: Effect.Effect<void, unknown, HttpClient>) => {
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
      fibers.add(fiber)
      fiber.addObserver(() => fibers.delete(fiber))
    },
    stop: () => {
      clientRuntime.runFork(Fiber.interruptAll([...fibers]))
    },
  }
}

// Runs one load until the effect that started it cleans up.
const runLoad = (load: Effect.Effect<void, unknown, HttpClient>) => {
  const loads = makeLoads()
  loads.run(load)
  return loads.stop
}

// Calls `listener` now and whenever `key` of the cursor changes.
function onCursorKey(
  cursor: ReplayCursor,
  key: (at: number) => number,
  listener: () => void
) {
  let last: number | undefined
  const check = () => {
    const next = key(cursor.state().at)
    if (next === last) return
    last = next
    listener()
  }
  check()
  return cursor.subscribe(check)
}

/** A recorded day's replay cursor, opened paused at its close. */
export function useReplayCursor(day: WibDate | undefined) {
  const cursor = useMemo(
    () =>
      day === undefined
        ? undefined
        : makeReplayCursor(
            replayDay(
              day,
              Effect.runSync(
                marketPhases(day).pipe(Effect.orElseSucceed(() => []))
              )
            )
          ),
    [day]
  )
  useEffect(() => () => cursor?.dispose(), [cursor])
  return cursor
}

// The selected code's book frame in force at the cursor: the chunk of the
// cursor's minute, replayed to it, and no book until that minute is
// answered, so a minute's frame never shows under a cursor on another;
// during Play the next minute's chunk is fetched ahead. A minute is asked
// for once; a load that failed forgets its minute, so the cursor's next step
// or visit asks again.
function followBook(
  day: WibDate,
  selected: StockCode,
  cursor: ReplayCursor,
  book: OrderBookStore
) {
  const chunks = new Map<number, Option.Option<BookChunk>>()
  const asked = new Set<number>()
  const loads = makeLoads()
  const show = () => {
    const { at, playing } = cursor.state()
    const minute = Math.floor(at / MINUTE) * MINUTE
    const chunk = chunks.get(minute)
    book.replace(
      chunk !== undefined && Option.isSome(chunk)
        ? Effect.runSync(bookAt(chunk.value, DateTime.makeUnsafe(at)))
        : undefined
    )
    if (chunk === undefined) load(minute)
    if (playing) load(minute + MINUTE)
  }
  const load = (minute: number) => {
    if (asked.has(minute)) return
    asked.add(minute)
    loads.run(
      Effect.gen(function* () {
        const chunk = yield* fetchRecordedBookChunk(
          day,
          selected,
          DateTime.makeUnsafe(minute)
        )
        chunks.set(minute, chunk)
        show()
      }).pipe(Effect.onError(() => Effect.sync(() => asked.delete(minute))))
    )
  }
  const stop = onCursorKey(cursor, (at) => Math.floor(at / BOOK_STEP_MS), show)
  return () => {
    stop()
    loads.stop()
  }
}

// The selected code's whole-day candles, onto the day's fresh store.
const loadCandles = (day: WibDate, selected: StockCode, candles: CandleStore) =>
  Effect.gen(function* () {
    const answer = yield* fetchRecordedCandles(day, selected)
    if (Option.isSome(answer))
      candles.apply({ _tag: "Delta", tape: [], candles: answer.value.candles })
  })

// Each watchlist code's candles once, its row worked out at each minute of
// the cursor.
function followWatchlist(
  day: WibDate,
  watchlist: ReadonlyArray<StockCode>,
  cursor: ReplayCursor,
  dayStates: DayStateStore
) {
  let answers: ReadonlyArray<RecordedCandles> = []
  let stop = () => {}
  const show = () => {
    const at = DateTime.makeUnsafe(cursor.state().at)
    dayStates.replace(answers.flatMap((answer) => dayStateAt(answer, at) ?? []))
  }
  const stopLoad = runLoad(
    Effect.gen(function* () {
      const fetched = yield* Effect.forEach(
        watchlist,
        (code) => fetchRecordedCandles(day, code),
        { concurrency: 4 }
      )
      answers = fetched.flatMap((answer) => Option.toArray(answer))
      stop = onCursorKey(cursor, (at) => Math.floor(at / MINUTE), show)
    })
  )
  return () => {
    stopLoad()
    stop()
  }
}

// The tape at the cursor. Paused, each move asks at once; during Play at
// most 4 times a second. The newest answer asked for wins.
function followTape(
  cursor: ReplayCursor,
  replace: (trades: ReadonlyArray<RunningTrade>) => void
) {
  const loads = makeLoads()
  let asked = 0
  let shown = 0
  let askedAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined
  const ask = () => {
    clearTimeout(timer)
    timer = undefined
    askedAt = performance.now()
    asked += 1
    const id = asked
    const at = DateTime.makeUnsafe(tapeInstant(cursor.day, cursor.state().at))
    loads.run(
      Effect.map(fetchRecordedTape(cursor.day.date, at), (trades) => {
        if (id < shown) return
        shown = id
        replace(trades)
      })
    )
  }
  const moved = () => {
    if (!cursor.state().playing) return ask()
    if (timer !== undefined) return
    const wait = askedAt + TAPE_INTERVAL_MS - performance.now()
    if (wait <= 0) ask()
    else timer = setTimeout(ask, wait)
  }
  const stop = onCursorKey(cursor, (at) => tapeInstant(cursor.day, at), moved)
  return () => {
    stop()
    clearTimeout(timer)
    loads.stop()
  }
}

/**
 * Fills the stores with `day` at the cursor, when there is one: the selected
 * code's whole-day candles and its book frame in force, and its and each
 * watchlist code's Day state. Returns the day's relay gaps.
 */
export function useRecordedDay({
  day,
  cursor,
  selected,
  watchlist,
  candles,
  book,
  dayStates,
}: {
  day: WibDate | undefined
  cursor: ReplayCursor | undefined
  selected: StockCode
  watchlist: ReadonlyArray<StockCode>
  candles: CandleStore
  book: OrderBookStore
  dayStates: DayStateStore
}): ReadonlyArray<RelayGap> {
  const [gaps, setGaps] = useState(NO_GAPS)
  useEffect(() => {
    if (day === undefined) return
    return runLoad(
      Effect.map(fetchRecordedGaps(day), (answer) => setGaps(answer))
    )
  }, [day])
  useEffect(() => {
    if (day === undefined) return
    return runLoad(loadCandles(day, selected, candles))
  }, [day, selected, candles])
  useEffect(() => {
    if (day === undefined || cursor === undefined) return
    return followBook(day, selected, cursor, book)
  }, [day, selected, cursor, book])
  // The selected code's figures head the chart.
  const watched = useMemo(
    () => [...new Set([selected, ...watchlist])],
    [selected, watchlist]
  )
  useEffect(() => {
    if (day === undefined || cursor === undefined) return
    return followWatchlist(day, watched, cursor, dayStates)
  }, [day, cursor, watched, dayStates])
  return gaps
}

const NO_GAPS: ReadonlyArray<RelayGap> = []

// The day's newest 200 trades at or before the cursor, with the relay gaps
// it has reached.
export function RecordedTape({
  cursor,
  gaps,
  selected,
  onSelect,
}: {
  cursor: ReplayCursor
  gaps: ReadonlyArray<RelayGap>
  selected: StockCode
  onSelect: (code: StockCode) => void
}) {
  const { tape, frame, replace } = useFramedTape()
  useEffect(() => followTape(cursor, replace), [cursor, replace])
  // The gaps that began by the cursor.
  const reached = useReplay(
    cursor,
    ({ at }) =>
      gaps.filter((gap) => DateTime.toEpochMillis(gap.from) <= at).length
  )
  const shownGaps = useMemo(
    () => gaps.filter((_, index) => index < reached),
    [gaps, reached]
  )
  return (
    <TapeSection>
      <TapeList
        tape={tape}
        frame={frame}
        selected={selected}
        onSelect={onSelect}
        gaps={shownGaps}
        className={TAPE_HEIGHT}
      />
    </TapeSection>
  )
}

// The selected code's stored book frame at the cursor, or "Not recorded"
// while the cursor is inside a relay gap.
export function RecordedOrderBook({
  store,
  cursor,
  gaps,
}: {
  store: OrderBookStore
  cursor: ReplayCursor
  gaps: ReadonlyArray<RelayGap>
}) {
  const inGap = useReplay(cursor, ({ at }) => gapAt(gaps, at) !== undefined)
  return <OrderBookPanel store={store} recorded notRecorded={inGap} />
}

// A recorded day's market conditions bar: the RECORDED pill in place of the feed
// pills, the day shown and where the cursor is; while the market is shut,
// its phase and next open.
export function RecordedConditionsBar({
  cursor,
  closed,
}: {
  cursor: ReplayCursor
  closed?:
    | { readonly phase: MarketPhase; readonly nextOpen?: number }
    | undefined
}) {
  const second = useReplay(cursor, ({ at }) =>
    at >= cursor.day.close ? undefined : Math.floor(at / 1_000) * 1_000
  )
  return (
    <div
      role="group"
      aria-label="Market conditions"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]"
    >
      <KStatusPill status="recorded" />
      <span aria-label="Day shown" className="font-medium">
        {dayLabel(cursor.day.date)}
        <span className="font-normal text-muted-foreground">
          {" "}
          · {second === undefined ? "at the close" : `at ${tapeTime(second)}`}
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
