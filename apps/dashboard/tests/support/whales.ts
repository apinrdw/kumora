import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Sweep, TapeBackfill, Wall } from "@/domain/trade"

/** The whale half of a `TapeBackfill`, for a test about the other half. */
export const noWhales: Pick<
  TapeBackfill,
  "sweeps" | "walls" | "threshold" | "wallCoverage" | "liveprice"
> = {
  sweeps: [],
  walls: [],
  threshold: {
    symbol: Symbol.make("BBCA"),
    threshold: null,
    warmingUp: true,
    prior: "none",
    ordersToday: 0,
    asOf: null,
  },
  wallCoverage: false,
  liveprice: {
    feed: "stockbit-liveprice",
    source: "none",
    asOf: null,
    freshness: "stale",
  },
}

/** ENRG's order on the 2026-10-29 capture, as its row reads once closed. */
export const enrgSweep: Sweep = {
  day: "2026-10-29",
  symbol: Symbol.make("ENRG"),
  firstNumber: 853_413,
  lastNumber: 853_610,
  side: "buy",
  board: "RG",
  tradedAt: IsoDateTime.make("2026-10-29T06:42:35.000Z"),
  lots: 48_766,
  value: 3_242_939_000,
  freq: 198,
  priceLow: 665,
  priceHigh: 665,
  threshold: 696,
  warmingUp: true,
  prior: "market",
  open: false,
  closedBy: "next-order",
  announcedAt: IsoDateTime.make("2026-10-29T06:42:35.100Z"),
  updatedAt: IsoDateTime.make("2026-10-29T06:42:36.100Z"),
  seq: 7,
}

/** BBCA's offer wall in the capture, still holding. */
export const bbcaWall: Wall = {
  day: "2026-10-29",
  symbol: Symbol.make("BBCA"),
  side: "offer",
  price: 5050,
  firstOrderNumber: "202610290002329192",
  memberOrderNumbers: ["202610290002329192"],
  hitsSeen: 95,
  lotsMatched: 1429,
  threshold: 696,
  warmingUp: true,
  prior: "market",
  firstSeen: IsoDateTime.make("2026-10-29T06:31:19.719Z"),
  lastSeen: IsoDateTime.make("2026-10-29T06:33:55.919Z"),
  closedAt: null,
  closedBy: null,
  seq: 3,
}
