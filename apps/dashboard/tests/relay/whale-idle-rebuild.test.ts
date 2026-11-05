import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Trade } from "@/domain/trade"
import { relayStore } from "@/relay/store"
import { closeIdle, createWhales, feedTrades, sketchOf } from "@/relay/whale"
import { rebuildWhales } from "@/relay/whale-persistence"

import { sqlStorage } from "../support/sql-storage"

const BBCA = Symbol.make("BBCA")
const DAY = "2026-10-29"
const PREVIOUS = "2026-10-28"
const T0 = Date.parse("2026-10-29T03:00:00.000Z")
const received = (ms: number) =>
  IsoDateTime.make(new Date(T0 + ms).toISOString())

/** 12 lots against a threshold of 10, all in one `tradedAt` millisecond. */
const trade = (tradeNumber: number, ms: number): Trade => ({
  symbol: BBCA,
  price: 100,
  volume: 1200,
  value: 120_000,
  side: "buy",
  board: "RG",
  tradedAt: received(0),
  receivedAt: received(ms),
  tradeNumber,
  change: 0,
})

describe("the idle deadline over a wake", () => {
  test.each([
    ["no alarm", false],
    ["an alarm", true],
  ])(
    "with %s in the gap, a rebuild lands where the uninterrupted run did",
    (_, alarm) => {
      const store = relayStore(sqlStorage())
      store.create()
      const prior = sketchOf([10])
      store.upsertSketch(BBCA, PREVIOUS, prior)
      const whales = createWhales({
        own: new Map([[BBCA, prior]]),
        market: null,
      })

      for (const [seq, tradeNumber, ms] of [
        [1, 1, 0],
        [2, 2, 501],
      ] as const) {
        if (alarm && seq === 2)
          for (const sweep of closeIdle(whales, T0 + 501, 1).sweeps)
            store.upsertSweep(sweep)
        const row = trade(tradeNumber, ms)
        store.appendBatch(BBCA, seq, DAY, received(ms), [row], null)
        for (const sweep of feedTrades(whales, [row], seq).sweeps)
          store.upsertSweep(sweep)
      }

      const rebuilt = rebuildWhales(store, DAY, [BBCA], 0)

      expect(whales.open.get(BBCA)?.firstNumber).toBe(2)
      expect(rebuilt.open.get(BBCA)?.firstNumber).toBe(2)
      expect(rebuilt.sketches.get(BBCA)?.n).toBe(1)
      expect(
        store
          .sweepsOf(DAY, BBCA)
          .map(({ firstNumber, lots, closedBy }) => ({
            firstNumber,
            lots,
            closedBy,
          }))
          .sort((a, b) => a.firstNumber - b.firstNumber)
      ).toEqual([
        { firstNumber: 1, lots: 12, closedBy: "idle" },
        { firstNumber: 2, lots: 12, closedBy: null },
      ])
    }
  )
})
