// Stockbit's running trade decoder on a real frame. Not a seam: a pure module
// the spec allows Vitest for (apinrdw/kumora#138, "Testing Decisions").
import { assert, describe, it } from "@effect/vitest"
import { StockCode, TradeNumber, WibDate } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { stockbitTrades } from "@/server/market-live/stockbit"

// One whole websocket frame, `running_trade_batch` holding one trade, captured
// from wss-jkt.trading.stockbit.com on 2026-07-29 (09:11:33 WIB).
const ABDA =
  "QlsKWQoMCNXCpdMGEMHg/OEBEgRBQkRBGQAAAAAAfKpAIQAAAAAAwHJAKAI6DAjVwqXTBhCIxqnbAUISCQAAAAAAAETAEc+NjietqPK/SIDtClABWQAAAABQCS9B"

const frame = (base64: string) =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

describe("stockbitTrades", () => {
  it.effect("decodes a running_trade_batch frame into running trades", () =>
    Effect.gen(function* () {
      const trades = yield* stockbitTrades(WibDate.make("2026-07-29"), [
        frame(ABDA),
      ])
      assert.deepStrictEqual(
        trades.map((trade) => ({
          ...trade,
          time: DateTime.formatIso(trade.time),
        })),
        [
          {
            tradeNumber: TradeNumber.make("177792"),
            // The trade's own time, to the millisecond, not the socket's.
            time: "2026-07-29T02:11:33.459Z",
            code: StockCode.make("ABDA"),
            price: 3390,
            // 300 shares.
            lots: 3,
            side: "sell",
            board: "RG",
            feeds: ["Stockbit"],
          },
        ]
      )
    })
  )

  it.effect("skips a trade from another trading day", () =>
    Effect.gen(function* () {
      const trades = yield* stockbitTrades(WibDate.make("2026-07-30"), [
        frame(ABDA),
      ])
      assert.deepStrictEqual(trades, [])
    })
  )

  it.effect("skips frames that aren't running trades or don't decode", () =>
    Effect.gen(function* () {
      // A ping reply (wrapper case 2), then bytes cut off mid-field.
      const ping = Uint8Array.of(0x12, 0x06, 0x0a, 0x04, 0x70, 0x6f, 0x6e, 0x67)
      const truncated = frame(ABDA).subarray(0, 40)
      const trades = yield* stockbitTrades(WibDate.make("2026-07-29"), [
        ping,
        truncated,
      ])
      assert.deepStrictEqual(trades, [])
    })
  )
})
