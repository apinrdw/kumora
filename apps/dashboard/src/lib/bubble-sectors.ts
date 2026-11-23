// Market Bubbles' sectors (spec apinrdw/kumora#427, "Sectors" and "The
// page"): which sector each code is in, the sector filter, each sector's
// figures for its label, and the two-level pack that places one cluster per
// sector on the canvas.
import {
  UNCLASSIFIED,
  type SectorMap,
  type SectorName,
  type StockCode,
} from "@workspace/relay"
import { Effect } from "effect"

import type { BubbleFigures } from "@/lib/bubbles"

export type SectorLookup = ReadonlyMap<StockCode, SectorName>

// Each classified code's sector; any other code is Unclassified.
export const sectorLookup = (map: SectorMap) =>
  Effect.sync(
    (): SectorLookup =>
      new Map(
        Object.entries(map.sectors).map(
          ([code, { sector }]) => [code as StockCode, sector] as const
        )
      )
  )

// A code's sector: Unclassified when the lookup has none.
export const sectorOf = (lookup: SectorLookup, code: StockCode) =>
  Effect.sync((): SectorName => lookup.get(code) ?? UNCLASSIFIED)

// The ranked bubbles of one sector, or all of them with none. It filters
// after the ranking, so a sector shows its codes of the market's Top N.
export const inSector = (
  bubbles: ReadonlyArray<BubbleFigures>,
  lookup: SectorLookup,
  sector: SectorName | undefined
) =>
  Effect.gen(function* () {
    if (sector === undefined) return bubbles
    const kept: Array<BubbleFigures> = []
    for (const bubble of bubbles)
      if ((yield* sectorOf(lookup, bubble.code)) === sector) kept.push(bubble)
    return kept
  })

// A sector's figures over the window, for its label: the size metric's
// total, its Buy/Sell delta %, and its change %, each code's weighted by its
// size; none when no code's change is known.
interface SectorGroup {
  readonly sector: SectorName
  readonly total: number
  readonly buySellDelta: number
  readonly change: number | undefined
  readonly codes: number
}

interface Gathered {
  total: number
  buy: number
  sell: number
  changed: number
  changeSize: number
  codes: number
}

// Every sector the bubbles are in, largest total first.
export const sectorGroups = (
  bubbles: ReadonlyArray<BubbleFigures>,
  lookup: SectorLookup
) =>
  Effect.gen(function* () {
    const gathered = new Map<SectorName, Gathered>()
    for (const bubble of bubbles) {
      const sector = yield* sectorOf(lookup, bubble.code)
      let held = gathered.get(sector)
      if (held === undefined) {
        held = {
          total: 0,
          buy: 0,
          sell: 0,
          changed: 0,
          changeSize: 0,
          codes: 0,
        }
        gathered.set(sector, held)
      }
      held.total += bubble.size
      held.buy += bubble.buyValue
      held.sell += bubble.sellValue
      held.codes += 1
      if (bubble.change !== undefined) {
        held.changed += bubble.change * bubble.size
        held.changeSize += bubble.size
      }
    }
    return [...gathered]
      .map(([sector, held]): SectorGroup => ({
        sector,
        total: held.total,
        buySellDelta:
          held.buy + held.sell === 0
            ? 0
            : ((held.buy - held.sell) / (held.buy + held.sell)) * 100,
        change:
          held.changeSize === 0 ? undefined : held.changed / held.changeSize,
        codes: held.codes,
      }))
      .sort((a, b) => b.total - a.total)
  })

// One sector's circle on the canvas.
export interface SectorCircle {
  readonly sector: SectorName
  x: number
  y: number
  readonly r: number
}

// A sector's circle holds its bubbles' area × SLACK, plus RIM px.
const SLACK = 1.5
const RIM = 18
// Room between two sectors' circles, for a label.
const GAP = 26
const PULLS = 220
const PULL = 0.02
// Passes of separation alone after the pull, until no two circles overlap.
const SETTLES = 500

// Pushes two circles at least GAP apart, the smaller further; true when they
// overlapped.
// `part` and `partAll` are plain functions, not Effects: a pack
// parts every pair of sectors up to 720 times, and the page packs each
// second. Measured 2026-11-16 on the dev machine, packing the 11 sectors:
// 0.4 ms plain, 2.6 ms with both as Effects. packSectors stays an Effect.
const part = (a: SectorCircle, b: SectorCircle) => {
  let dx = b.x - a.x
  let dy = b.y - a.y
  let distance = Math.hypot(dx, dy)
  if (distance === 0) {
    // On top of each other: part them along x.
    dx = 1
    dy = 0
    distance = 1
  }
  const overlap = a.r + b.r + GAP - distance
  if (overlap <= 0) return false
  const weightA = b.r / (a.r + b.r)
  const push = overlap / distance
  a.x -= dx * push * weightA
  a.y -= dy * push * weightA
  b.x += dx * push * (1 - weightA)
  b.y += dy * push * (1 - weightA)
  return a.r + b.r - distance > 1e-9
}

const partAll = (circles: ReadonlyArray<SectorCircle>) => {
  let overlapped = false
  for (let i = 0; i < circles.length; i++)
    for (let j = i + 1; j < circles.length; j++)
      if (part(circles[i]!, circles[j]!)) overlapped = true
  return overlapped
}

// The pack relaxes from where the last one left each sector, so
// a recompute moves the clusters only as far as their totals changed; the
// canvas eases toward these targets. A first pack starts with the largest
// at the centre and the rest round it.
//
// A canvas with no room, as a hidden tab's, places none, and a point the
// last pack left that isn't finite starts afresh. The pull is capped at
// 1/PULL: past it, each pass would overshoot further than the last.
export const packSectors = (
  areas: ReadonlyArray<{ readonly sector: SectorName; readonly area: number }>,
  width: number,
  height: number,
  previous: ReadonlyMap<
    SectorName,
    { readonly x: number; readonly y: number }
  > = new Map()
) =>
  Effect.sync((): Array<SectorCircle> => {
    if (width <= 0 || height <= 0) return []
    const cx = width / 2
    const cy = height / 2
    const sorted = [...areas].sort((a, b) => b.area - a.area)
    const circles = sorted.map(({ sector, area }, index): SectorCircle => {
      const angle = (index / sorted.length) * Math.PI * 2
      const held = previous.get(sector)
      const from =
        held !== undefined && Number.isFinite(held.x) && Number.isFinite(held.y)
          ? held
          : {
              x: index === 0 ? cx : cx + Math.cos(angle) * width * 0.3,
              y: index === 0 ? cy : cy + Math.sin(angle) * height * 0.3,
            }
      return {
        sector,
        x: from.x,
        y: from.y,
        r: Math.sqrt((area * SLACK) / Math.PI) + RIM,
      }
    })
    // A wide canvas pulls less across, so the clusters spread to fill it.
    const across = Math.min(height / width, 1 / PULL)
    for (let pull = 0; pull < PULLS; pull++) {
      for (const circle of circles) {
        circle.x += (cx - circle.x) * PULL * across
        circle.y += (cy - circle.y) * PULL
      }
      partAll(circles)
    }
    for (let settle = 0; settle < SETTLES && partAll(circles); settle++);
    return circles
  })
