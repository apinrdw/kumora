// The volume profile's rows as the chart draws them. No `effect` here, and the domain only as types.
import type { ProfileLevel } from "@/domain/trade"

/** The exchange's smallest price step, for a profile with one price. */
const SMALLEST_TICK = 1

export type ProfileRow = {
  /** The row's price edges, half a tick past its outer prices. */
  readonly from: number
  readonly to: number
  readonly buy: number
  readonly sell: number
  readonly unspecified: number
}

/** The closest two prices traded: the symbol's tick, as far as the tape shows it. */
const tickOf = (levels: ReadonlyArray<ProfileLevel>) => {
  let tick = Infinity
  for (let i = 1; i < levels.length; i++)
    tick = Math.min(tick, levels[i]!.price - levels[i - 1]!.price)
  return Number.isFinite(tick) ? tick : SMALLEST_TICK
}

/**
 * One row per price, or, past `maxRows`, rows a whole number of ticks wide. Levels are lowest
 * price first, as the fold keeps them.
 */
export const profileRows = (
  levels: ReadonlyArray<ProfileLevel>,
  maxRows: number
): ReadonlyArray<ProfileRow> => {
  const low = levels[0]?.price
  const high = levels.at(-1)?.price
  if (low === undefined || high === undefined) return []
  const tick = tickOf(levels)
  const ticks = Math.round((high - low) / tick) + 1
  const width = Math.ceil(ticks / maxRows) * tick
  const rows = new Map<number, ProfileRow>()
  for (const { price, buy, sell, unspecified } of levels) {
    const i = Math.floor((price - low + tick / 2) / width)
    const from = low - tick / 2 + i * width
    const row = rows.get(i) ?? {
      from,
      to: from + width,
      buy: 0,
      sell: 0,
      unspecified: 0,
    }
    rows.set(i, {
      ...row,
      buy: row.buy + buy,
      sell: row.sell + sell,
      unspecified: row.unspecified + unspecified,
    })
  }
  return [...rows.values()]
}
