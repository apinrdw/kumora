// Every code's latest book readings (spec apinrdw/kumora#517, "Data"): read
// on each delta tick from the books that changed, kept for the snapshot.
import {
  READING_PHASES,
  bookReadingsOf,
  marketMomentAt,
  marketPhases,
  type BookReadings,
  type MarketPhase,
  type OrderBook,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Option, type Schema } from "effect"

export const makeReadingsBook = (options: { readonly date: WibDate }) =>
  Effect.sync(() => {
    const latest = new Map<StockCode, BookReadings>()

    // The readings of `books`, the ones that changed, kept and returned.
    // Decision: readings are taken only in Sessions 1 and 2, by the market
    // phase; in any other phase each code keeps its last ones and none goes
    // out, so the page greys them and names the phase. See spec
    // apinrdw/kumora#517, "Data".
    const read = Effect.fnUntraced(function* (
      books: ReadonlyArray<OrderBook>,
      phase: MarketPhase
    ) {
      if (!READING_PHASES.has(phase)) return []
      const taken: Array<BookReadings> = []
      for (const book of books) {
        const readings = yield* bookReadingsOf(book)
        latest.set(book.code, readings)
        taken.push(readings)
      }
      return taken
    })

    // Every code's latest readings, for a snapshot.
    const all = Effect.sync(() => [...latest.values()])

    // A restarted object's last served book of a code: its readings come
    // back from it when it was served in a session, or else from the book
    // in force when the last session before it ended (`bookAt`, from the
    // stored chunks), so the break's and the close's snapshots keep the
    // session's last values, as they do without a restart.
    const restore = Effect.fnUntraced(function* (
      book: OrderBook,
      bookAt: (
        code: StockCode,
        at: DateTime.Utc
      ) => Effect.Effect<OrderBook | undefined, Schema.SchemaError>
    ) {
      const moment = yield* Effect.option(marketMomentAt(book.at))
      if (Option.isNone(moment)) return
      if (READING_PHASES.has(moment.value.phase))
        return yield* read([book], moment.value.phase)
      const ended = (yield* marketPhases(options.date))
        .filter(
          (each) =>
            READING_PHASES.has(each.phase) &&
            DateTime.isLessThanOrEqualTo(each.to, book.at)
        )
        .at(-1)
      if (ended === undefined) return
      const last = yield* bookAt(
        book.code,
        DateTime.subtract(ended.to, { milliseconds: 1 })
      )
      if (last !== undefined) yield* read([last], ended.phase)
    })

    return { read, all, restore }
  })
