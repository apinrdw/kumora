// Spec apinrdw/kumora#437, "The build": at the largest day the store
// accepts (1.5M trades, broker-codes.ts's status Decision), the build holds
// one entry per (code, broker, investor type) and per code, never a trade.
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

import { assert, describe, it } from "@effect/vitest"
import { BrokerCode, StockCode, type TradeCodes } from "@workspace/relay"
import { Effect } from "effect"

import type { BrokerCodesStore } from "@/server/market-live/broker-codes"
import { buildBrokerTotals } from "@/server/market-live/broker-totals"

setFlagsFromString("--expose-gc")
const gc = runInNewContext("gc") as () => void

const TRADES = 1_500_000
const PAGE = 64_000
const CODES = Array.from({ length: 900 }, (_, k) =>
  StockCode.make(`S${String(k).padStart(3, "0")}`)
)
const BROKERS = Array.from({ length: 90 }, (_, k) =>
  BrokerCode.make(String.fromCharCode(65 + Math.floor(k / 26), 65 + (k % 26)))
)

type Page = NonNullable<
  Effect.Success<ReturnType<BrokerCodesStore["heldTradesPage"]>>
>

// Trade n's codes and fields, made when its page is asked for, so the
// source holds no page once the build moved past it.
const pageAfter = (after: number) =>
  Effect.sync((): Page | undefined => {
    const first = after + 1
    if (first >= TRADES) return undefined
    const last = Math.min(first + PAGE, TRADES) - 1
    const trades: Array<Page["trades"][number]> = []
    for (let n = first; n <= last; n++) {
      // Each code meets every broker on both sides, of both types.
      const round = Math.floor(n / CODES.length)
      const codes: TradeCodes = {
        buyer: BROKERS[round % BROKERS.length]!,
        buyerType: Math.floor(round / BROKERS.length) % 2 === 0 ? "F" : "D",
        seller: BROKERS[(round + 1) % BROKERS.length]!,
        sellerType: Math.floor(round / BROKERS.length) % 2 === 0 ? "D" : "F",
      }
      trades.push({
        code: CODES[n % CODES.length]!,
        price: 1_000 + (n % 50),
        lots: 1 + (n % 9),
        board: "RG",
        codes,
      })
    }
    return { trades, last }
  })

describe("the broker totals build at the largest accepted day", () => {
  it.effect(
    "holds totals bounded by codes × brokers × investor types, not by trades",
    () =>
      Effect.gen(function* () {
        gc()
        const before = process.memoryUsage().heapUsed
        const built = yield* buildBrokerTotals({ heldTradesPage: pageAfter })
        gc()
        const held = process.memoryUsage().heapUsed - before

        assert.strictEqual(
          built.totals.length,
          CODES.length * BROKERS.length * 2
        )
        assert.strictEqual(built.candles.length, CODES.length)
        assert.strictEqual(
          built.candles.reduce((sum, candle) => sum + candle.trades, 0),
          TRADES
        )
        // 162,000 totals hold about 15 MB; a build that kept the day's
        // trades held about 200 MB.
        assert.isBelow(held, 64 * 1024 * 1024)
      }),
    { timeout: 30_000 }
  )
})
