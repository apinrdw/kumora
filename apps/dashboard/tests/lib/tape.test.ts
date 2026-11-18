import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  applyViewerMessage,
  emptyTape,
  freezeTape,
  isBigTrade,
  tapeLength,
  tapeRows,
} from "@/lib/tape"

// A trade on 2026-11-09 at `wib` (HH:MM:SS.sss), numbered `n`.
function trade(
  n: number,
  overrides: Partial<Omit<RunningTrade, "time">> & { wib?: string } = {}
): RunningTrade {
  const { wib = "09:00:01.000", ...rest } = overrides
  return {
    tradeNumber: TradeNumber.make(String(n)),
    time: DateTime.makeUnsafe(`2026-11-09T${wib}+07:00`),
    code: StockCode.make("BBCA"),
    price: 9_000,
    lots: 1,
    side: "buy",
    board: "RG",
    feeds: ["Ajaib"],
    ...rest,
  }
}

const delta = (...tape: Array<RunningTrade>): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(0),
  tape,
  candles: [],
  footprints: [],
})
const snapshot = (...tape: Array<RunningTrade>): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe(0),
  selected: StockCode.make("BBCA"),
  tape,
  candles: [],
  footprints: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

// What the list shows, newest first, with every fold in `open` expanded.
const shown = Effect.fnUntraced(function* (
  messages: ReadonlyArray<ViewerDown>,
  open: ReadonlyArray<"opening" | "closing"> = []
) {
  let tape = yield* emptyTape()
  for (const message of messages)
    tape = yield* applyViewerMessage(tape, message)
  const rows = yield* tapeRows(tape, new Set(open), 0, Number.MAX_SAFE_INTEGER)
  return rows.map((row) =>
    row.kind === "fold"
      ? `${row.match} fold: ${row.trades} trades, ${row.codes} codes`
      : row.trade.tradeNumber
  )
})

describe("the tape", () => {
  it.effect("lists trades newest first, a late one in its place", () =>
    Effect.gen(function* () {
      expect(
        yield* shown([snapshot(trade(1), trade(2)), delta(trade(5), trade(3))])
      ).toEqual(["5", "3", "2", "1"])
      expect(
        yield* shown([snapshot(trade(1)), delta(trade(4)), delta(trade(2))])
      ).toEqual(["4", "2", "1"])
    })
  )

  it.effect(
    "a known trade number replaces the trade it held, counted once",
    () =>
      Effect.gen(function* () {
        let tape = yield* applyViewerMessage(
          yield* emptyTape(),
          snapshot(trade(1), trade(2))
        )
        tape = yield* applyViewerMessage(
          tape,
          delta(trade(1, { feeds: ["Stockbit", "Ajaib"], side: "sell" }))
        )
        const [, oldest] = yield* tapeRows(tape, new Set(), 0, 2)
        expect(oldest).toMatchObject({
          trade: {
            tradeNumber: "1",
            side: "sell",
            feeds: ["Stockbit", "Ajaib"],
          },
        })
        expect(tape.received).toBe(2)
      })
  )

  it.effect(
    "keeps the 10,000 newest continuous trades and drops older arrivals",
    () =>
      Effect.gen(function* () {
        const trades = Array.from({ length: 10_050 }, (_, i) => trade(i + 1))
        let tape = yield* applyViewerMessage(
          yield* emptyTape(),
          delta(...trades)
        )
        tape = yield* applyViewerMessage(tape, delta(trade(20)))
        const rows = yield* tapeRows(
          tape,
          new Set(),
          0,
          Number.MAX_SAFE_INTEGER
        )
        expect(rows).toHaveLength(10_000)
        expect(rows.at(0)).toMatchObject({ trade: { tradeNumber: "10050" } })
        expect(rows.at(-1)).toMatchObject({ trade: { tradeNumber: "51" } })
      })
  )
})

describe("auction matches", () => {
  const opening = (n: number, code = "BBCA", lots = 1) =>
    trade(n, {
      wib: "08:58:00.004",
      code: StockCode.make(code),
      lots,
      side: "none",
    })

  it.effect(
    "fold into one summary row at their place, with the trades, value and codes",
    () =>
      Effect.gen(function* () {
        const messages = [
          delta(opening(1), opening(2, "TLKM"), opening(3, "TLKM", 2)),
          delta(trade(5), trade(4)),
        ]
        expect(yield* shown(messages)).toEqual([
          "5",
          "4",
          "opening fold: 3 trades, 2 codes",
        ])
        expect(yield* shown(messages, ["opening"])).toEqual([
          "5",
          "4",
          "opening fold: 3 trades, 2 codes",
          "3",
          "2",
          "1",
        ])
        let tape = yield* emptyTape()
        for (const message of messages)
          tape = yield* applyViewerMessage(tape, message)
        expect(yield* tapeRows(tape, new Set(), 2, 3)).toEqual([
          {
            kind: "fold",
            match: "opening",
            trades: 3,
            value: 4 * 9_000 * 100,
            codes: 2,
            live: false,
          },
        ])
      })
  )

  it.effect("the closing match folds apart from the opening one", () =>
    Effect.gen(function* () {
      expect(
        yield* shown([
          delta(
            opening(1),
            trade(2),
            trade(3, { wib: "16:00:00.000" }),
            trade(4, { wib: "16:02:00.000" })
          ),
        ])
      ).toEqual([
        "4",
        "closing fold: 1 trades, 1 codes",
        "2",
        "opening fold: 1 trades, 1 codes",
      ])
    })
  )

  it.effect("a fold is live until continuous trading passes it", () =>
    Effect.gen(function* () {
      let tape = yield* applyViewerMessage(
        yield* emptyTape(),
        delta(opening(1))
      )
      expect(yield* tapeRows(tape, new Set(), 0, 1)).toMatchObject([
        { live: true },
      ])
      tape = yield* applyViewerMessage(tape, delta(trade(2)))
      expect(yield* tapeRows(tape, new Set(), 1, 2)).toMatchObject([
        { live: false },
      ])
    })
  )

  it.effect(
    "negotiated and cash prints in the match second, and continuous trading, never fold",
    () =>
      Effect.gen(function* () {
        expect(
          yield* shown([
            delta(
              trade(1, { wib: "08:58:00.000", board: "NG" }),
              trade(2, { wib: "16:00:00.000", board: "TN" }),
              trade(3, { wib: "08:58:01.000" }),
              trade(4, { wib: "15:59:59.999" })
            ),
          ])
        ).toEqual(["4", "3", "2", "1"])
      })
  )

  it.effect("sit outside the cap, and drop off once the cap passes them", () =>
    Effect.gen(function* () {
      const matchPrints = Array.from({ length: 20_000 }, (_, i) =>
        opening(i + 1)
      )
      const session = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => trade(from + i))
      let tape = yield* applyViewerMessage(
        yield* emptyTape(),
        delta(...matchPrints)
      )
      tape = yield* applyViewerMessage(tape, delta(...session(20_001, 10_000)))
      expect(yield* tapeLength(tape, new Set())).toBe(10_001)
      expect(yield* tapeLength(tape, new Set(["opening"]))).toBe(30_001)
      tape = yield* applyViewerMessage(tape, delta(...session(30_001, 1)))
      expect(yield* tapeLength(tape, new Set())).toBe(10_000)
      // A late print of a fold that dropped off stays dropped, and isn't new.
      const received = tape.received
      tape = yield* applyViewerMessage(tape, delta(opening(20_000)))
      expect(yield* tapeLength(tape, new Set())).toBe(10_000)
      expect(tape.received).toBe(received)
    })
  )

  it.effect("a print that turns out negotiated leaves the fold", () =>
    Effect.gen(function* () {
      let tape = yield* applyViewerMessage(
        yield* emptyTape(),
        delta(opening(1), opening(2))
      )
      tape = yield* applyViewerMessage(
        tape,
        delta(trade(2, { wib: "08:58:00.004", board: "NG" }))
      )
      expect(yield* tapeRows(tape, new Set(), 0, 9)).toMatchObject([
        { kind: "trade", trade: { tradeNumber: "2" } },
        { kind: "fold", trades: 1, codes: 1 },
      ])
      expect(tape.received).toBe(2)
    })
  )
})

it.effect("a frozen tape holds still while deltas arrive", () =>
  Effect.gen(function* () {
    const live = yield* applyViewerMessage(yield* emptyTape(), delta(trade(1)))
    const frozen = yield* freezeTape(live)
    yield* applyViewerMessage(live, delta(trade(2)))
    expect(yield* tapeRows(frozen, new Set(), 0, 9)).toHaveLength(1)
    expect(live.received - frozen.received).toBe(1)
  })
)

it.effect(
  "a reconnect's snapshot counts only the trades the tape didn't hold as received",
  () =>
    Effect.gen(function* () {
      const trades = Array.from({ length: 300 }, (_, i) => trade(i + 1))
      const live = yield* applyViewerMessage(
        yield* emptyTape(),
        delta(...trades)
      )
      const frozen = yield* freezeTape(live)
      // The socket's first snapshot: the 200 newest, 50 of them new.
      const reconnected = yield* applyViewerMessage(
        live,
        snapshot(...Array.from({ length: 200 }, (_, i) => trade(i + 151)))
      )
      expect(reconnected.received - frozen.received).toBe(50)
      expect(yield* tapeRows(reconnected, new Set(), 0, 1)).toMatchObject([
        { trade: { tradeNumber: "350" } },
      ])
    })
)

it.effect(
  "a snapshot's sweep alerts mark their rows, and the marks the tape held carry over",
  () =>
    Effect.gen(function* () {
      const alert = (side: "buy" | "sell", ...numbers: Array<number>) => ({
        code: StockCode.make("BBCA"),
        side,
        lots: 100,
        tradeNumbers: numbers.map((n) => TradeNumber.make(String(n))),
      })
      const live = yield* applyViewerMessage(yield* emptyTape(), {
        ...delta(trade(1), trade(2), trade(3), trade(4)),
        sweepAlerts: [alert("sell", 1)],
      })
      // A reconnect: the object restarted and lost the sell alert; the
      // buy alert is one it decided since.
      const reconnected = yield* applyViewerMessage(live, {
        ...snapshot(trade(1), trade(2), trade(3), trade(4)),
        sweepAlerts: [alert("buy", 3, 4)],
      })
      expect([...reconnected.alertSides].sort()).toEqual([
        ["1", "sell"],
        ["3", "buy"],
        ["4", "buy"],
      ])
    })
)

it.effect("a big trade is Rp1 B or more on the regular board", () =>
  Effect.gen(function* () {
    expect(yield* isBigTrade(trade(1, { price: 10_000, lots: 1_000 }))).toBe(
      true
    )
    expect(yield* isBigTrade(trade(1, { price: 10_000, lots: 999 }))).toBe(
      false
    )
    expect(
      yield* isBigTrade(trade(1, { price: 10_000, lots: 1_000, board: "NG" }))
    ).toBe(false)
  })
)
