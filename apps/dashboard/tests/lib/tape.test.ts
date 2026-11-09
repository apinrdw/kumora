import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime } from "effect"
import { describe, expect, test } from "vitest"

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
  tape,
  candles: [],
})
const snapshot = (...tape: Array<RunningTrade>): ViewerDown => ({
  _tag: "Snapshot",
  tape,
  candles: [],
  status: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

// What the list shows, newest first, with every fold in `open` expanded.
function shown(
  messages: ReadonlyArray<ViewerDown>,
  open: ReadonlyArray<"opening" | "closing"> = []
) {
  let tape = emptyTape()
  for (const message of messages) tape = applyViewerMessage(tape, message)
  return tapeRows(tape, new Set(open), 0, Number.MAX_SAFE_INTEGER).map((row) =>
    row.kind === "fold"
      ? `${row.match} fold: ${row.trades} trades, ${row.codes} codes`
      : row.trade.tradeNumber
  )
}

describe("the tape", () => {
  test("lists trades newest first, a late one in its place", () => {
    expect(
      shown([snapshot(trade(1), trade(2)), delta(trade(5), trade(3))])
    ).toEqual(["5", "3", "2", "1"])
    expect(
      shown([snapshot(trade(1)), delta(trade(4)), delta(trade(2))])
    ).toEqual(["4", "2", "1"])
  })

  test("a known trade number replaces the trade it held, counted once", () => {
    let tape = applyViewerMessage(emptyTape(), snapshot(trade(1), trade(2)))
    tape = applyViewerMessage(
      tape,
      delta(trade(1, { feeds: ["Stockbit", "Ajaib"], side: "sell" }))
    )
    const [, oldest] = tapeRows(tape, new Set(), 0, 2)
    expect(oldest).toMatchObject({
      trade: { tradeNumber: "1", side: "sell", feeds: ["Stockbit", "Ajaib"] },
    })
    expect(tape.received).toBe(2)
  })

  test("keeps the 10,000 newest continuous trades and drops older arrivals", () => {
    const trades = Array.from({ length: 10_050 }, (_, i) => trade(i + 1))
    let tape = applyViewerMessage(emptyTape(), delta(...trades))
    tape = applyViewerMessage(tape, delta(trade(20)))
    const rows = tapeRows(tape, new Set(), 0, Number.MAX_SAFE_INTEGER)
    expect(rows).toHaveLength(10_000)
    expect(rows.at(0)).toMatchObject({ trade: { tradeNumber: "10050" } })
    expect(rows.at(-1)).toMatchObject({ trade: { tradeNumber: "51" } })
  })
})

describe("auction matches", () => {
  const opening = (n: number, code = "BBCA", lots = 1) =>
    trade(n, {
      wib: "08:58:00.004",
      code: StockCode.make(code),
      lots,
      side: "none",
    })

  test("fold into one summary row at their place, with the trades, value and codes", () => {
    const messages = [
      delta(opening(1), opening(2, "TLKM"), opening(3, "TLKM", 2)),
      delta(trade(5), trade(4)),
    ]
    expect(shown(messages)).toEqual([
      "5",
      "4",
      "opening fold: 3 trades, 2 codes",
    ])
    expect(shown(messages, ["opening"])).toEqual([
      "5",
      "4",
      "opening fold: 3 trades, 2 codes",
      "3",
      "2",
      "1",
    ])
    let tape = emptyTape()
    for (const message of messages) tape = applyViewerMessage(tape, message)
    expect(tapeRows(tape, new Set(), 2, 3)).toEqual([
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

  test("the closing match folds apart from the opening one", () => {
    expect(
      shown([
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

  test("a fold is live until continuous trading passes it", () => {
    let tape = applyViewerMessage(emptyTape(), delta(opening(1)))
    expect(tapeRows(tape, new Set(), 0, 1)).toMatchObject([{ live: true }])
    tape = applyViewerMessage(tape, delta(trade(2)))
    expect(tapeRows(tape, new Set(), 1, 2)).toMatchObject([{ live: false }])
  })

  test("negotiated and cash prints in the match second, and continuous trading, never fold", () => {
    expect(
      shown([
        delta(
          trade(1, { wib: "08:58:00.000", board: "NG" }),
          trade(2, { wib: "16:00:00.000", board: "TN" }),
          trade(3, { wib: "08:58:01.000" }),
          trade(4, { wib: "15:59:59.999" })
        ),
      ])
    ).toEqual(["4", "3", "2", "1"])
  })

  test("sit outside the cap, and drop off once the cap passes them", () => {
    const matchPrints = Array.from({ length: 20_000 }, (_, i) => opening(i + 1))
    const session = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => trade(from + i))
    let tape = applyViewerMessage(emptyTape(), delta(...matchPrints))
    tape = applyViewerMessage(tape, delta(...session(20_001, 10_000)))
    expect(tapeLength(tape, new Set())).toBe(10_001)
    expect(tapeLength(tape, new Set(["opening"]))).toBe(30_001)
    tape = applyViewerMessage(tape, delta(...session(30_001, 1)))
    expect(tapeLength(tape, new Set())).toBe(10_000)
    // A late print of a fold that dropped off stays dropped, and isn't new.
    const received = tape.received
    tape = applyViewerMessage(tape, delta(opening(20_000)))
    expect(tapeLength(tape, new Set())).toBe(10_000)
    expect(tape.received).toBe(received)
  })

  test("a print that turns out negotiated leaves the fold", () => {
    let tape = applyViewerMessage(emptyTape(), delta(opening(1), opening(2)))
    tape = applyViewerMessage(
      tape,
      delta(trade(2, { wib: "08:58:00.004", board: "NG" }))
    )
    expect(tapeRows(tape, new Set(), 0, 9)).toMatchObject([
      { kind: "trade", trade: { tradeNumber: "2" } },
      { kind: "fold", trades: 1, codes: 1 },
    ])
    expect(tape.received).toBe(2)
  })
})

test("a frozen tape holds still while deltas arrive", () => {
  const live = applyViewerMessage(emptyTape(), delta(trade(1)))
  const frozen = freezeTape(live)
  applyViewerMessage(live, delta(trade(2)))
  expect(tapeRows(frozen, new Set(), 0, 9)).toHaveLength(1)
  expect(live.received - frozen.received).toBe(1)
})

test("a big trade is Rp1 B or more on the regular board", () => {
  expect(isBigTrade(trade(1, { price: 10_000, lots: 1_000 }))).toBe(true)
  expect(isBigTrade(trade(1, { price: 10_000, lots: 999 }))).toBe(false)
  expect(
    isBigTrade(trade(1, { price: 10_000, lots: 1_000, board: "NG" }))
  ).toBe(false)
})
