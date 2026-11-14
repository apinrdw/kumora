// A footprint's cells (spec apinrdw/kumora#263, "The trading-day Durable
// Object"): one stock code's lots in one minute, by price and aggressor
// side. The candle book keeps them beside each candle (candles.ts) and the
// day store writes them as a footprint row (day-store.ts).
import type { FootprintCell, RunningTrade } from "@workspace/relay"
import { Effect } from "effect"

// The lots at one price.
interface Lots {
  sell: number
  buy: number
  none: number
}

// A minute's cells by price. The book owns each map and adds to it in place.
export type Cells = Map<number, Lots>

export const noCells = Effect.sync((): Cells => new Map())

export const copyCells = (cells: Cells) =>
  Effect.sync(
    (): Cells =>
      new Map([...cells].map(([price, lots]) => [price, { ...lots }]))
  )

// Adds a regular-board trade's lots to its price, under its aggressor side:
// an auction match has none, so it counts only as no-side lots.
export const addTrade = (cells: Cells, trade: RunningTrade) =>
  Effect.sync(() => {
    let lots = cells.get(trade.price)
    if (lots === undefined) {
      lots = { sell: 0, buy: 0, none: 0 }
      cells.set(trade.price, lots)
    }
    lots[trade.side] += trade.lots
  })

// The cells as viewers get them, ascending by price.
export const cellsOut = (cells: Cells) =>
  Effect.sync((): ReadonlyArray<FootprintCell> =>
    [...cells]
      .sort(([a], [b]) => a - b)
      .map(([price, lots]) => ({ price, ...lots }))
  )

// Decision: a footprint row stores its cells as one JSON text of
// [price, sell, buy, none] tuples, ascending by price: a busy code has under
// 1,000 cells a day, so a minute's row stays small, and the row is replaced
// whole like a candle's. See spec apinrdw/kumora#263.
export const cellsText = (cells: Cells) =>
  Effect.map(cellsOut(cells), (out) =>
    JSON.stringify(
      out.map((cell) => [cell.price, cell.sell, cell.buy, cell.none])
    )
  )

// Rows are the store's own writes, so they are read back without a decode.
export const cellsFromText = (text: string) =>
  Effect.sync(
    (): Cells =>
      new Map(
        (
          JSON.parse(text) as ReadonlyArray<
            readonly [price: number, sell: number, buy: number, none: number]
          >
        ).map(([price, sell, buy, none]) => [price, { sell, buy, none }])
      )
  )
