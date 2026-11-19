// Each stock code's regular-board value on the previous trading day (spec
// apinrdw/kumora#517, "Data"), for the order book radar's value floor: the
// previous sealed day's object answers it (`dayValuesAnswer`), and today's
// asks it once a day and keeps it (`makePreviousValues`).
import { StockCode, WibDate, isTradingDay } from "@workspace/relay"
import type { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Option, Schema } from "effect"

import { Fact } from "./day-store.ts"

const DayValues = Schema.Struct({
  values: Schema.Array(Schema.Tuple([StockCode, Schema.Finite])),
})
const DayValuesJson = Schema.fromJsonString(DayValues)
const encodeDayValues = Schema.encodeEffect(DayValuesJson)
const decodeDayValues = Schema.decodeUnknownEffect(DayValuesJson)

// A day's answer to ObjectPath.dayValues with its encoded values, as its
// object built it or the move stored it (cold-days.ts); and a day's answer
// without values.
export const dayValuesResponse = (body: ReadableStream | string) =>
  new Response(body, { headers: { "Content-Type": "application/json" } })
export const noDayValues = () => new Response(null, { status: 404 })

// A day's answer to ObjectPath.dayValues: every stock code's regular-board
// value once sealed, 404 before, as a day still recording would answer
// values that change.
export const dayValuesAnswer = Effect.fnUntraced(function* (
  sealed: boolean,
  days: Effect.Effect<
    ReadonlyArray<{ readonly code: StockCode; readonly value: number }>
  >
) {
  if (!sealed) return noDayValues()
  const values = (yield* days).map(({ code, value }) => [code, value] as const)
  return dayValuesResponse(yield* encodeDayValues({ values }))
})

// Decision: the previous trading day looks back at most this many days,
// the longest IDX closure the schedule allows for (`closedTradingDay`).
const LOOK_BACK_DAYS = 31

// The trading day before `date`; none past the schedule's years.
const previousTradingDay = Effect.fnUntraced(function* (date: WibDate) {
  for (let days = 1; days <= LOOK_BACK_DAYS; days++) {
    const before = WibDate.make(
      DateTime.formatIsoDate(
        DateTime.add(DateTime.makeUnsafe(date), { days: -days })
      )
    )
    const trading = yield* isTradingDay(before).pipe(
      Effect.orElseSucceed(() => false)
    )
    if (trading) return Option.some(before)
  }
  return Option.none<WibDate>()
})

// The previous day's object answered neither its values nor 404; the next
// token asks again.
class DayValuesRefused extends Schema.TaggedError<DayValuesRefused>()(
  "DayValuesRefused",
  { status: Schema.Int }
) {}

// An answer's values text; none on 404, a day not sealed.
const answerText = Effect.fnUntraced(function* (response: Response) {
  if (response.status === 404) return undefined
  if (!response.ok)
    return yield* new DayValuesRefused({ status: response.status })
  return yield* Effect.tryPromise(() => response.text())
})

const NONE: ReadonlyMap<StockCode, number> = new Map()

// Decision: today's object asks the previous trading day's for its values
// once a day, on the relay's token, and keeps them as a day store fact. A
// 404 (a day the relay didn't seal, after a gap) keeps none, so the floor
// reads today's value alone; a failed ask keeps nothing and asks again on
// the next token. See spec apinrdw/kumora#517, "Data".
export const makePreviousValues = Effect.fnUntraced(function* (options: {
  readonly date: WibDate
  readonly fact: (key: string) => Effect.Effect<string | undefined>
  readonly setFact: (key: string, value: string) => Effect.Effect<void>
  // Asks the named day's object for its values; never asked when absent.
  readonly fetchDay:
    | ((date: WibDate) => Effect.Effect<Response, unknown, WorkerEnv>)
    | undefined
}) {
  const stored = yield* options.fact(Fact.previousValues)
  const kept = (text: string) =>
    Effect.map(
      decodeDayValues(text),
      ({ values }) => new Map(values) as ReadonlyMap<StockCode, number>
    )
  let held =
    stored === undefined
      ? undefined
      : yield* kept(stored).pipe(Effect.orElseSucceed(() => undefined))

  const ask = Effect.fnUntraced(function* (
    fetchDay: (date: WibDate) => Effect.Effect<Response, unknown, WorkerEnv>
  ) {
    const previous = yield* previousTradingDay(options.date)
    const text = Option.isNone(previous)
      ? undefined
      : yield* Effect.flatMap(fetchDay(previous.value), answerText)
    const answer = text ?? (yield* encodeDayValues({ values: [] }))
    held = yield* kept(answer)
    yield* options.setFact(Fact.previousValues, answer)
  })

  // Asks once a day; later calls hold what came.
  const load = Effect.suspend(() => {
    const { fetchDay } = options
    if (held !== undefined || fetchDay === undefined) return Effect.void
    return ask(fetchDay).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Previous day's values not read", cause)
      )
    )
  })

  // A code's value on the previous trading day; none after a gap or
  // before it came.
  const valueOf = (code: StockCode) =>
    Effect.sync(() => (held ?? NONE).get(code))

  return { load, valueOf }
})
