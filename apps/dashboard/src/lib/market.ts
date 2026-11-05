import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { MarketOverview } from "@/features/shell/schema"

/** Market-wide demo figures shown in the shell, as of the last price-feed update. Synthetic; every screen carries DATA DEMO. */
export const MARKET_OVERVIEW: MarketOverview = {
  ihsg: { last: 7243.18, changePct: 0.42 },
  foreignNet: 534e9,
  netForeignTape: (
    [
      ["BBRI", 318],
      ["BBCA", 412],
      ["BREN", -42],
      ["ANTM", 64],
      ["PGAS", 47],
      ["TLKM", 88],
      ["MDKA", 12],
      ["ASII", 22],
      ["ICBP", 31],
      ["ADRO", -51],
      ["UNVR", -88],
      ["GOTO", -197],
    ] as const
  ).map(([symbol, netMiliar]): readonly [symbol: Symbol, netMiliar: number] => [
    Symbol.make(symbol),
    netMiliar,
  ]),
  asOf: IsoDateTime.make("2026-10-23T07:45:00Z"),
}

/**
 * Fourteen demo sessions: [open, high, low, close] offsets
 * from a base price, plus volume as a multiple of a unit. Ported from Main.dc.html.
 */
export const SESSION_SHAPE: ReadonlyArray<
  readonly [number, number, number, number, number]
> = [
  [0, 40, -30, 15, 1.0],
  [15, 55, 0, 42, 1.3],
  [42, 60, 20, 28, 0.9],
  [28, 35, -10, -5, 1.1],
  [-5, 10, -40, -32, 1.6],
  [-32, -20, -60, -48, 1.4],
  [-48, -10, -55, 4, 2.4],
  [4, 70, 0, 61, 2.9],
  [61, 95, 50, 88, 2.1],
  [88, 120, 80, 112, 1.8],
  [112, 130, 96, 104, 1.2],
  [104, 150, 100, 141, 1.9],
  [141, 160, 120, 128, 1.1],
  [128, 190, 125, 175, 2.6],
]
