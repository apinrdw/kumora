import { readFileSync } from "node:fs"

export type TradeRow = [
  symbol: string,
  price: number,
  volume: number,
  side: "B" | "S" | "-",
  time: string,
  tradeNumber: number,
  board: string,
  value: number,
]

type LiveRow = [
  receivedAt: string,
  symbol: string,
  price: number,
  quantity: number,
  verb: string,
  orderNumber: string,
  matchNumber: string,
]

type Capture = {
  batches: ReadonlyArray<{ t: string; trades: ReadonlyArray<TradeRow> }>
  liveprice: ReadonlyArray<LiveRow>
}

export const SIDE = { B: "buy", S: "sell", "-": "unspecified" } as const

export const readWhaleFixture = <T>(name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/whale/${name}`, import.meta.url), "utf8")
  ) as T

export const readCapture = () => readWhaleFixture<Capture>("capture.json")
