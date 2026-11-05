export type Candle = {
  /** Axis label, e.g. "14 Okt". */
  label: string
  o: number
  h: number
  l: number
  c: number
  /** Shares traded. */
  v?: number
  vwap?: number
}

export type PricePoint = {
  /** Axis label, unique per point, e.g. "09.15" or "14 Okt". */
  label: string
  price: number
  vwap?: number
  /** Shares traded in the interval. */
  volume?: number
}
