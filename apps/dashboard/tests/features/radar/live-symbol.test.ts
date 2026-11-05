import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type {
  LiveSymbol,
  RelayStatus,
  TapeCoverage,
  TapeProvenance,
  Trade,
} from "@/domain/trade"
import { emptyDemoTape } from "@/features/radar/demo-tape"
import {
  liveSymbolState,
  reduceLiveSymbol,
  refold,
  symbolRefresh,
} from "@/features/radar/live-symbol"
import { NO_CANDLES } from "@/relay/candles"

const BBCA = Symbol.make("BBCA")
const provenance: TapeProvenance = {
  feed: "stockbit-running-trades",
  source: "extension",
  asOf: null,
  freshness: "live",
}
const trade = (tradeNumber: number, tradedAt: string, price = 100): Trade => ({
  symbol: BBCA,
  price,
  volume: 100,
  value: price * 100,
  side: "buy",
  board: "RG",
  tradeNumber,
  tradedAt: IsoDateTime.make(tradedAt),
  receivedAt: IsoDateTime.make(tradedAt),
  change: 0,
})
const live = (over: Partial<LiveSymbol["backfill"]> = {}): LiveSymbol => ({
  backfill: { ...emptyDemoTape(BBCA), day: "2026-10-29", ...over },
  candles: NO_CANDLES,
})
const trades = (seq: number, batch: ReadonlyArray<Trade>) =>
  ({
    type: "frame",
    frame: { type: "trades", seq, provenance, trades: batch },
  }) as const

describe("the live symbol's candles", () => {
  test("a trades frame extends them, and a repeat does not", () => {
    const frame = trades(1, [trade(1, "2026-10-29T03:00:00.000Z")])
    const once = reduceLiveSymbol(liveSymbolState(live()), frame)
    expect(once.candles.candles).toHaveLength(1)
    expect(once.seq).toBe(1)
    expect(reduceLiveSymbol(once, frame).candles).toEqual(once.candles)
  })

  test("a new day starts them over", () => {
    const today = reduceLiveSymbol(
      liveSymbolState(live()),
      trades(1, [trade(50, "2026-10-29T03:00:00.000Z")])
    )
    const tomorrow = reduceLiveSymbol(
      today,
      trades(2, [trade(1, "2026-10-30T03:00:00.000Z")])
    )
    expect(tomorrow.candles.candles.map((c) => c.at)).toEqual([
      "2026-10-30T03:00:00.000Z",
    ])
  })

  test("a refold heals a hole and keeps what the page heard past it", () => {
    const held = reduceLiveSymbol(
      liveSymbolState(live()),
      trades(2, [trade(3, "2026-10-29T03:05:00.000Z", 130)])
    )
    const fresh = {
      ...live(),
      candles: {
        lastNumber: 2,
        candles: [
          {
            at: IsoDateTime.make("2026-10-29T03:00:00.000Z"),
            open: 100,
            high: 100,
            low: 100,
            close: 100,
            lots: 2,
          },
        ],
        profile: [{ price: 100, buy: 2, sell: 0, unspecified: 0 }],
      },
    }
    const healed = refold(held, fresh)
    expect(healed.candles.lastNumber).toBe(3)
    expect(healed.candles.candles.map((c) => c.at)).toEqual([
      "2026-10-29T03:00:00.000Z",
      "2026-10-29T03:05:00.000Z",
    ])
    expect(healed.candles.profile).toEqual([
      { price: 100, buy: 2, sell: 0, unspecified: 0 },
      { price: 130, buy: 1, sell: 0, unspecified: 0 },
    ])
  })

  test("a refold brings back the off-board trades a capped resume left out", () => {
    const negotiated = (tradeNumber: number, tradedAt: string): Trade => ({
      ...trade(tradeNumber, tradedAt),
      board: "NG",
    })
    const before = negotiated(1, "2026-10-29T03:00:00.000Z")
    const missed = negotiated(3, "2026-10-29T03:10:00.000Z")
    const after = negotiated(5, "2026-10-29T03:20:00.000Z")
    const held = reduceLiveSymbol(
      liveSymbolState(live({ offBoard: [before] })),
      trades(9, [after])
    )
    const fresh = live({ offBoard: [missed, before] })
    expect(refold(held, fresh).tape.offBoard.map((t) => t.tradeNumber)).toEqual(
      [5, 3, 1]
    )
  })

  test("a refold of another day changes nothing", () => {
    const held = liveSymbolState(live())
    expect(refold(held, live({ day: "2026-10-28" }))).toBe(held)
  })
})

const change = (at: string, source: TapeCoverage["source"]): TapeCoverage => ({
  at: IsoDateTime.make(at),
  source,
})
const statusFrame = (
  source: RelayStatus["source"],
  coverage: ReadonlyArray<TapeCoverage> = []
) =>
  ({
    type: "frame",
    frame: {
      type: "status",
      status: {
        source,
        freshness: source === "none" ? "stale" : "live",
        reason: source === "none" ? "no-source" : null,
        upstreamEnabled: false,
        upstreamState: "disabled",
        credentialExpiresAt: null,
        ingests: 1,
        datafeed: true,
        clients: 1,
        lastTradeAt: null,
        seq: 0,
        day: "2026-10-29",
        symbols: 0,
        trades: 0,
        calendarOutOfDate: false,
        sweeps: 0,
        walls: 0,
        wallCoverage: [],
        thresholds: { symbols: 0, warmingUp: 0 },
        coverage,
      },
    },
  }) as const

describe("the live symbol's source changes", () => {
  const opened = [change("2026-10-29T01:00:00.000Z", "extension")]

  test("start from the backfill's", () => {
    expect(liveSymbolState(live({ coverage: opened })).coverage).toEqual(opened)
  })

  test("take each status frame's record in place of the page's", () => {
    const recorded = [...opened, change("2026-10-29T02:10:00.000Z", "none")]
    const held = reduceLiveSymbol(
      liveSymbolState(live({ coverage: opened })),
      statusFrame("none", recorded)
    )
    expect(held.coverage).toEqual(recorded)
  })

  test("show a flap between first paint and the first status, though the source is back", () => {
    const flapped = [
      ...opened,
      change("2026-10-29T02:00:00.000Z", "none"),
      change("2026-10-29T02:01:00.000Z", "extension"),
    ]
    const held = reduceLiveSymbol(
      liveSymbolState(live({ coverage: opened })),
      statusFrame("extension", flapped)
    )
    expect(held.coverage).toEqual(flapped)
  })

  test("a refold leaves them to the status frames", () => {
    const recorded = [...opened, change("2026-10-29T02:10:00.000Z", "none")]
    const held = reduceLiveSymbol(
      liveSymbolState(live({ coverage: opened })),
      statusFrame("none", recorded)
    )
    expect(refold(held, live({ coverage: opened })).coverage).toEqual(recorded)
  })
})

describe("asking the relay for a symbol again", () => {
  test("an answer overtaken by a later ask is not applied", async () => {
    const answers: Array<(fresh: LiveSymbol) => void> = []
    const applied: Array<LiveSymbol> = []
    const refresh = symbolRefresh(
      () => new Promise((resolve) => answers.push(resolve)),
      (fresh) => applied.push(fresh)
    )
    const first = refresh()
    const second = refresh()
    const [answerFirst, answerSecond] = answers
    const older = live({ seq: 1 })
    const newer = live({ seq: 2 })
    answerSecond?.(newer)
    await second
    answerFirst?.(older)
    await first
    expect(applied).toEqual([newer])
  })
})
