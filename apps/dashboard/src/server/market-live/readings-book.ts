// Every code's latest book readings (spec apinrdw/kumora#517, "Data"): read
// on each delta tick from the books that changed, kept for the snapshot.
import {
  READING_PHASES,
  bookReadingsOf,
  marketMomentAt,
  type BookReadings,
  type MarketPhase,
  type OrderBook,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option } from "effect"

export const makeReadingsBook = (options: {
  readonly date: WibDate
  // A code's regular-board value today.
  readonly valueOf: (code: StockCode) => Effect.Effect<number>
}) =>
  Effect.sync(() => {
    const latest = new Map<StockCode, BookReadings>()

    // The readings of `books`, the ones that changed, kept and returned with
    // the codes that had none before; `lastOf` is a code's last price, for
    // the limit mark.
    // Decision: readings are taken only in Sessions 1 and 2, by the market
    // phase; in any other phase each code keeps its last ones and none goes
    // out, so the page greys them and names the phase. See spec
    // apinrdw/kumora#517, "Data".
    const read = Effect.fnUntraced(function* (
      books: ReadonlyArray<OrderBook>,
      phase: MarketPhase,
      lastOf: (code: StockCode) => Effect.Effect<number | undefined>
    ) {
      const taken: Array<BookReadings> = []
      const first: Array<StockCode> = []
      if (!READING_PHASES.has(phase)) return { taken, first }
      for (const book of books) {
        if (!latest.has(book.code)) first.push(book.code)
        const readings = yield* bookReadingsOf(book, {
          date: options.date,
          last: yield* lastOf(book.code),
          value: yield* options.valueOf(book.code),
        })
        latest.set(book.code, readings)
        taken.push(readings)
      }
      return { taken, first }
    })

    // Every code's latest readings, for a snapshot.
    const all = Effect.sync(() => [...latest.values()])

    // A restarted object's last served book of a code: its readings come
    // back when it was served in a session, so the break's snapshots keep
    // the session's last values.
    const restore = Effect.fnUntraced(function* (
      book: OrderBook,
      lastOf: (code: StockCode) => Effect.Effect<number | undefined>
    ) {
      const moment = yield* Effect.option(marketMomentAt(book.at))
      if (Option.isSome(moment)) yield* read([book], moment.value.phase, lastOf)
    })

    return { read, all, restore }
  })
