import type { TradeFrame } from "@/domain/trade"

/**
 * What a page's new socket hears first. The status comes first because one that
 * advances the day clears the page's figures, and an unchanged `liveprice` frame is
 * not sent again. The quote comes after the trades, which would fold into it. The
 * caller's status broadcast then has the last word, as a `trades` frame of missed batches says `live`.
 * Sweeps and walls follow the trades, and upserting them twice is harmless. The threshold
 * comes after them, because each carries the one of when it is sent.
 */
export const openingFrames = ({
  status,
  missed,
  sweeps,
  walls,
  threshold,
  quote,
}: {
  readonly status: TradeFrame
  readonly missed: TradeFrame | null
  readonly sweeps: ReadonlyArray<TradeFrame>
  readonly walls: ReadonlyArray<TradeFrame>
  readonly threshold: TradeFrame
  readonly quote: TradeFrame | null
}): ReadonlyArray<TradeFrame> =>
  [status, missed, ...sweeps, ...walls, threshold, quote].filter(
    (frame) => frame !== null
  )
