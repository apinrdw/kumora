// The level ledger (spec apinrdw/kumora#517, "Book events"): for one price on
// one side of a code's order book, between two consecutive frames of that
// side, the lots it showed against the lots regular-board trades with an
// aggressor side took there. Read over a rolling 30 s window, it finds the
// book events. The rules are the replay's of docs/research/book-event-thresholds
// (replay.mjs.txt), which tuned every threshold below on 2026-11-17.
import {
  BOOK_EVENT_WINDOW_MS as WINDOW_MS,
  MIN_SIDE_FRAMES as MIN_FRAMES,
  levelValue,
  ticksBetween,
  type BookEvent,
  type BookEventSide,
  type BookLevel,
  type OrderBook,
  type RunningTrade,
  type StockCode,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

// Decision: absorbed needs trades of at least 1 × the lots the level showed
// at the window's start: below 1 it hasn't turned over once, and at 1.5 mid
// and quiet codes show almost none. See apinrdw/kumora#508.
const ABSORBED_MULTIPLE = 1

// Decision: absorbed and reloaded need Rp100 M traded, eaten a peak of Rp100
// M shown: at Rp250 M mid codes at the open drop from 0.48 to 0.20 events a
// minute. See apinrdw/kumora#508.
const LEVEL_FLOOR = 100_000_000

// Decision: a wall holds at least 5 × its side's median lots: at 3 almost
// every side always has one. See apinrdw/kumora#508.
const WALL_MULTIPLE = 5

// Decision: a wall is worth at least Rp500 M: Rp1 B misses the day's
// clearest walls, FOLK's 50K-lot bids of about Rp500 M each. See
// apinrdw/kumora#508.
const WALL_FLOOR = 500_000_000

// Decision: a level is eaten when the window's trades at it are at least 0.6
// of its peak: departures fall in two groups, and 0.5–0.75 picks the same
// events. See apinrdw/kumora#508.
const EATEN_SHARE = 0.6

// Decision: a wall is pulled when trades explain less than 0.25 of what it
// lost: 8 of 14 pulls had no trades, and 0.1–0.5 picks the same events but
// one. See apinrdw/kumora#508.
const PULLED_SHARE = 0.25

// Decision: a wall moved when, within 2 frames, lots within ±20% of what
// left it arrived at another price with the same change in orders: the
// owner's amended rule compares the change, not the whole level. See
// apinrdw/kumora#508.
const MOVED_TOLERANCE = 0.2
const MOVED_FRAMES = 2

// Decision: "as price approached" is a pull within 3 ticks of the best price,
// closer than when the wall formed: pulls happened 0–1 ticks away, too few to
// tighten it. See apinrdw/kumora#508.
const APPROACH_TICKS = 3

// The best levels absorbed and eaten read.
const BEST_LEVELS = 3
// The levels a side carries: a wall past the last is out of view.
const VIEW_LEVELS = 20
// The same kind at the same side and price fires at most once a window, as
// in the replay.
const REPEAT_MS = WINDOW_MS
// Frames kept past the window: a pull reads two frames back from a frame
// two behind the newest, and a move the frame before each arrival.
const KEPT_FRAMES = 2 * MOVED_FRAMES + 3

type Side = BookEventSide

interface Frame {
  readonly t: number
  readonly sequence: number | undefined
  readonly levels: ReadonlyArray<BookLevel>
  readonly walls: ReadonlySet<number>
}

interface SideLedger {
  frames: Array<Frame>
  // Each wall's distance from the best price, in ticks, when it formed.
  readonly births: Map<number, number>
  readonly fired: Map<string, number>
  readonly refills: Map<number, number>
}

interface Trade {
  readonly t: number
  readonly price: number
  readonly lots: number
  readonly side: "buy" | "sell"
}

interface CodeLedger {
  provenance: OrderBook["provenance"]
  bid: SideLedger
  offer: SideLedger
  trades: Array<Trade>
}

// The aggressor side whose trades hit a book side: a sell hits bids.
const HITTING = { bid: "sell", offer: "buy" } as const

// What one side frame is read with: the frames up to it, the frame read
// (`i`), where its window starts (`from`) and the last frame before that
// (`start`), and the trades that hit the side.
interface Reading {
  readonly code: StockCode
  readonly side: Side
  readonly ledger: SideLedger
  readonly frames: ReadonlyArray<Frame>
  readonly i: number
  readonly from: number
  readonly start: number
  readonly trades: ReadonlyArray<Trade>
}

// Decision: the ledger's helpers stay plain closures inside its Effects: they
// run for every price of every side frame, inside the delta tick. On node,
// replaying fixtures/book-events-2026-11-17.json's 949 side frames through the
// ledger took 7.7 ms with plain helpers and 21 ms with every helper an Effect
// (119 more Effects a frame), each the median of 100 alternating replays,
// 2.7 times as long. See spec apinrdw/kumora#517.
export const makeLevelLedger = Effect.sync(() => {
  const codes = new Map<StockCode, CodeLedger>()

  const emptySide = (): SideLedger => ({
    frames: [],
    births: new Map(),
    fired: new Map(),
    refills: new Map(),
  })

  const lotsAt = (levels: ReadonlyArray<BookLevel>, price: number) =>
    levels.find((level) => level.price === price)
  // Bids run high to low, offers low to high: a price is in view when the
  // carried levels reach it.
  const inView = (side: Side, levels: ReadonlyArray<BookLevel>, p: number) => {
    if (levels.length < VIEW_LEVELS) return true
    const last = levels.at(-1)!.price
    return side === "bid" ? p >= last : p <= last
  }
  const median = (values: ReadonlyArray<number>) => {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const middle = sorted.length >> 1
    return sorted.length % 2
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2
  }
  const value = (lots: number, price: number) => levelValue(price, lots)
  const wallsOf = (levels: ReadonlyArray<BookLevel>) => {
    const floor = WALL_MULTIPLE * median(levels.map((level) => level.lots))
    return new Set(
      levels
        .filter(
          (level) =>
            level.lots >= floor && value(level.lots, level.price) >= WALL_FLOOR
        )
        .map((level) => level.price)
    )
  }
  const ticksFromBest = (levels: ReadonlyArray<BookLevel>, p: number) => {
    const best = levels[0]?.price ?? p
    return ticksBetween(Math.min(best, p), Math.max(best, p))
  }

  // The lots trades of the side's aggressor took at `p` after `from`, up to
  // `to`.
  const hit = (r: Reading, p: number, from: number, to: number) => {
    const hitting = HITTING[r.side]
    let lots = 0
    for (const trade of r.trades)
      if (
        trade.side === hitting &&
        trade.price === p &&
        trade.t > from &&
        trade.t <= to
      )
        lots += trade.lots
    return lots
  }
  // Whether any trade went through `p`, past it from the side's best.
  const tradedBeyond = (r: Reading, p: number, from: number, to: number) =>
    r.trades.some(
      (trade) =>
        trade.t > from &&
        trade.t <= to &&
        (r.side === "bid" ? trade.price < p : trade.price > p)
    )

  // A side frame's own time and sequence; a book without them has its
  // served time.
  const sideOf = (book: OrderBook, side: Side) =>
    side === "bid"
      ? { own: book.bidAt, sequence: book.bidSequence, levels: book.bids }
      : { own: book.offerAt, sequence: book.offerSequence, levels: book.offers }

  const isLater = (
    t: number,
    sequence: number | undefined,
    last: Frame
  ): boolean =>
    t > last.t ||
    (t === last.t &&
      sequence !== undefined &&
      last.sequence !== undefined &&
      sequence > last.sequence)

  // The side's frame this book carries, if it is a new one: a later time
  // and sequence of its own, or, for a book without them, changed levels.
  const frameOf = (book: OrderBook, side: Side, last: Frame | undefined) => {
    const { own, sequence, levels } = sideOf(book, side)
    const t = DateTime.toEpochMillis(own ?? book.at)
    const fresh: Frame = { t, sequence, levels, walls: wallsOf(levels) }
    if (last === undefined) return fresh
    if (!isLater(t, sequence, last) && own !== undefined) return undefined
    if (t < last.t) return undefined
    const same =
      own === undefined &&
      JSON.stringify(levels) === JSON.stringify(last.levels)
    return same ? undefined : fresh
  }

  const ledgerOf = (book: OrderBook) => {
    const held = codes.get(book.code)
    const unread =
      held !== undefined &&
      held.bid.frames.length === 0 &&
      held.offer.frames.length === 0
    if (unread) held.provenance = book.provenance
    // Decision: a switch between Stockbit and Ajaib resets the code's ledger:
    // the other feed's book is rebuilt, not a change of this one. See spec
    // apinrdw/kumora#517, "Book events".
    if (held !== undefined && held.provenance === book.provenance) return held
    const fresh: CodeLedger = {
      provenance: book.provenance,
      bid: emptySide(),
      offer: emptySide(),
      trades: held?.trades ?? [],
    }
    codes.set(book.code, fresh)
    return fresh
  }

  // Frame `i` read against its window, or none while the side is too quiet
  // or holds no frame from before the window to read it against.
  const readingAt = (
    code: StockCode,
    side: Side,
    ledger: SideLedger,
    trades: ReadonlyArray<Trade>,
    i: number
  ): Reading | undefined => {
    const frames = ledger.frames
    if (i < 1) return undefined
    const from = frames[i]!.t - WINDOW_MS
    let start = i
    while (start > 0 && frames[start]!.t > from) start--
    if (frames[start]!.t > from || i - start < MIN_FRAMES) return undefined
    return { code, side, ledger, frames, i, from, start, trades }
  }

  const common = (r: Reading, p: number) => ({
    code: r.code,
    at: DateTime.makeUnsafe(r.frames[r.i]!.t),
    side: r.side,
    price: p,
  })

  // Absorbed: a best-3 level at the window's start, standing in every frame
  // since, took at least its start lots with no trade beyond it.
  const absorbed = (r: Reading) => {
    const frame = r.frames[r.i]!
    const found: Array<BookEvent> = []
    for (const first of r.frames[r.start]!.levels.slice(0, BEST_LEVELS)) {
      const p = first.price
      const stood = r.frames
        .slice(r.start, r.i + 1)
        .every((each) => lotsAt(each.levels, p) !== undefined)
      if (!stood) continue
      const traded = hit(r, p, r.from, frame.t)
      const now = lotsAt(frame.levels, p)!
      const took =
        traded >= ABSORBED_MULTIPLE * first.lots &&
        value(traded, p) >= LEVEL_FLOOR
      if (took && !tradedBeyond(r, p, r.from, frame.t))
        found.push({
          kind: "absorbed",
          ...common(r, p),
          lots: traded,
          orders: now.orders,
          shown: now.lots,
        })
    }
    return found
  }

  // Eaten: a best-3 level or a wall left the book on this frame, still in
  // view, and the window's trades at it explain most of its peak.
  const eaten = (r: Reading) => {
    const frame = r.frames[r.i]!
    const previous = r.frames[r.i - 1]!
    const leaving = new Set([
      ...previous.levels.slice(0, BEST_LEVELS).map((level) => level.price),
      ...previous.walls,
    ])
    const found: Array<BookEvent> = []
    for (const p of leaving) {
      if (lotsAt(frame.levels, p) !== undefined) continue
      if (!inView(r.side, frame.levels, p)) continue
      const peak = Math.max(
        0,
        ...r.frames
          .slice(r.start, r.i)
          .map((each) => lotsAt(each.levels, p)?.lots ?? 0)
      )
      const traded = hit(r, p, r.from, frame.t)
      if (value(peak, p) >= LEVEL_FLOOR && traded >= EATEN_SHARE * peak)
        found.push({
          kind: "eaten",
          ...common(r, p),
          lots: peak,
          orders: lotsAt(previous.levels, p)?.orders ?? 0,
          share: Math.min(1, traded / peak),
        })
    }
    return found
  }

  // Reloaded: the best level traded more than it showed in one interval
  // while it stayed best (overflow), or was hit down by half and refilled at
  // the same price.
  const reloadOf = (r: Reading) => {
    const frame = r.frames[r.i]!
    const previous = r.frames[r.i - 1]!
    const b0 = previous.levels[0]
    const b1 = frame.levels[0]
    if (b0 === undefined || b1 === undefined || b0.price !== b1.price)
      return undefined
    const p = b0.price
    const overflow = hit(r, p, previous.t, frame.t)
    if (overflow > b0.lots && value(overflow, p) >= LEVEL_FLOOR)
      return {
        p,
        lots: overflow,
        orders: b1.orders,
        shown: b1.lots,
        crowd: b1.orders > 1,
      }
    const before = r.frames[r.i - 2]
    const a = before?.levels[0]
    if (before === undefined || a?.price !== p) return undefined
    const traded = hit(r, p, before.t, previous.t)
    const drop = a.lots - b0.lots
    const hitDown = drop >= 0.5 * a.lots && traded >= 0.5 * drop
    const refilled = b1.lots >= 0.5 * a.lots && b1.lots > b0.lots
    return hitDown && refilled && value(traded, p) >= LEVEL_FLOOR
      ? {
          p,
          lots: traded,
          orders: b1.orders,
          shown: b1.lots,
          crowd: b1.orders - b0.orders > 1,
        }
      : undefined
  }
  const reloaded = (r: Reading): ReadonlyArray<BookEvent> => {
    const reload = reloadOf(r)
    if (reload === undefined) return []
    const refills = (r.ledger.refills.get(reload.p) ?? 0) + 1
    r.ledger.refills.set(reload.p, refills)
    return [
      {
        kind: "reloaded",
        ...common(r, reload.p),
        lots: reload.lots,
        orders: reload.orders,
        shown: reload.shown,
        refills,
        crowd: reload.crowd,
      },
    ]
  }

  // Wall appeared: a level in view became a wall, mostly by added lots.
  const appeared = Effect.fnUntraced(function* (r: Reading) {
    const frame = r.frames[r.i]!
    const previous = r.frames[r.i - 1]!
    const found: Array<BookEvent> = []
    for (const p of frame.walls) {
      if (previous.walls.has(p) || !inView(r.side, previous.levels, p)) continue
      const now = lotsAt(frame.levels, p)!
      const before = lotsAt(previous.levels, p)?.lots ?? 0
      if (now.lots - before >= 0.5 * now.lots)
        found.push({
          kind: "appeared",
          ...common(r, p),
          lots: now.lots,
          orders: now.orders,
          ticks: yield* ticksFromBest(frame.levels, p),
        })
    }
    return found
  })

  // The wall price that gained about `loss` lots with `lostOrders` more
  // orders within MOVED_FRAMES of frame `i`, other than `p`.
  const arrivalOf = (
    r: Reading,
    p: number,
    loss: number,
    lostOrders: number
  ) => {
    let to: number | undefined
    const last = Math.min(r.frames.length - 1, r.i + MOVED_FRAMES)
    for (let x = Math.max(1, r.i - MOVED_FRAMES); x <= last; x++)
      for (const q of r.frames[x]!.walls) {
        const now = lotsAt(r.frames[x]!.levels, q)!
        const before = lotsAt(r.frames[x - 1]!.levels, q)
        const gained = now.lots - (before?.lots ?? 0)
        const matched =
          Math.abs(gained - loss) <= MOVED_TOLERANCE * loss &&
          now.orders - (before?.orders ?? 0) === lostOrders
        if (q !== p && matched) to = q
      }
    return to
  }

  // The wall at `p` in frame `j`, if it was pulled or moved by frame `i`:
  // it lost half its lots while in view, with no trade beyond it and trades
  // explaining little of the loss.
  const leftWall = Effect.fnUntraced(function* (
    r: Reading,
    j: number,
    p: number
  ) {
    const wallFrame = r.frames[j]!
    const frame = r.frames[r.i]!
    const wall = lotsAt(wallFrame.levels, p)!
    const viewed = r.frames
      .slice(j, r.i + 1)
      .every((each) => inView(r.side, each.levels, p))
    const left = lotsAt(frame.levels, p)
    const loss = wall.lots - (left?.lots ?? 0)
    const pulled =
      viewed &&
      loss >= 0.5 * wall.lots &&
      !tradedBeyond(r, p, wallFrame.t, frame.t) &&
      hit(r, p, wallFrame.t, frame.t) < PULLED_SHARE * loss
    if (!pulled) return undefined
    const lostOrders = wall.orders - (left?.orders ?? 0)
    const to = arrivalOf(r, p, loss, lostOrders)
    if (to !== undefined)
      return {
        kind: "moved",
        ...common(r, p),
        lots: loss,
        orders: lostOrders,
        wallLots: wall.lots,
        to,
      } satisfies BookEvent
    const ticks = yield* ticksFromBest(wallFrame.levels, p)
    const atBirth = r.ledger.births.get(p) ?? ticks
    return {
      kind: "pulled",
      ...common(r, p),
      lots: wall.lots,
      orders: wall.orders,
      ticks,
      approached: ticks <= APPROACH_TICKS && ticks < atBirth,
    } satisfies BookEvent
  })

  // Pulled or moved: a wall one or two frames before frame `i`. A wall read
  // as moved from either frame is not also pulled.
  const walls = Effect.fnUntraced(function* (r: Reading) {
    const found = new Map<number, BookEvent>()
    for (const j of [r.i - 1, r.i - 2].filter((each) => each >= 0))
      for (const p of r.frames[j]!.walls) {
        if (found.get(p)?.kind === "moved") continue
        const event = yield* leftWall(r, j, p)
        if (event !== undefined) found.set(p, event)
      }
    return [...found.values()]
  })

  // Each wall's distance from the best price when it formed.
  const noteBirths = Effect.fnUntraced(function* (ledger: SideLedger) {
    const frame = ledger.frames.at(-1)!
    const previous = ledger.frames.at(-2)
    for (const p of frame.walls)
      if (previous === undefined || !previous.walls.has(p))
        ledger.births.set(p, yield* ticksFromBest(frame.levels, p))
  })

  // Whether `event` fires: the same kind at the same price fires at most once
  // a window. A pull and a move are one wall leaving.
  const fires = (ledger: SideLedger, event: BookEvent) => {
    const kind = event.kind === "moved" ? "pulled" : event.kind
    const key = `${kind}|${event.price}`
    const t = DateTime.toEpochMillis(event.at)
    const last = ledger.fired.get(key)
    if (last !== undefined && Math.abs(t - last) < REPEAT_MS) return false
    ledger.fired.set(key, t)
    return true
  }

  // The newest side frame read against the window behind it. A pull is read
  // on the frame MOVED_FRAMES behind it, so the arrival that makes it a move
  // can come after.
  const read = Effect.fnUntraced(function* (
    code: StockCode,
    side: Side,
    ledger: SideLedger,
    trades: ReadonlyArray<Trade>
  ) {
    yield* noteBirths(ledger)
    const i = ledger.frames.length - 1
    const found: Array<BookEvent> = []
    const now = readingAt(code, side, ledger, trades, i)
    if (now !== undefined)
      found.push(
        ...absorbed(now),
        ...eaten(now),
        ...reloaded(now),
        ...(yield* appeared(now))
      )
    const back = readingAt(code, side, ledger, trades, i - MOVED_FRAMES)
    if (back !== undefined) found.push(...(yield* walls(back)))
    return found.filter((event) => fires(ledger, event))
  })

  // A regular-board trade with an aggressor side; any other is no hit.
  const trade = (arriving: RunningTrade) =>
    Effect.sync(() => {
      if (arriving.board !== "RG" || arriving.side === "none") return
      let held = codes.get(arriving.code)
      if (held === undefined) {
        held = {
          provenance: "Stockbit",
          bid: emptySide(),
          offer: emptySide(),
          trades: [],
        }
        codes.set(arriving.code, held)
      }
      const t = DateTime.toEpochMillis(arriving.time)
      const kept = held.trades
      while (kept.length > 0 && kept[0]!.t <= t - 2 * WINDOW_MS) kept.shift()
      let at = kept.length
      while (at > 0 && kept[at - 1]!.t > t) at--
      kept.splice(at, 0, {
        t,
        price: arriving.price,
        lots: arriving.lots,
        side: arriving.side,
      })
    })

  // Kept back to the last frame before the window of the frame a pull is
  // read on.
  const prune = (ledger: SideLedger) => {
    const frames = ledger.frames
    const pulledAt = frames.at(-1 - MOVED_FRAMES)?.t ?? frames.at(-1)!.t
    while (frames.length > KEPT_FRAMES && frames[1]!.t <= pulledAt - WINDOW_MS)
      frames.shift()
  }

  // A served book: the events its new side frames show.
  const book = Effect.fnUntraced(function* (served: OrderBook) {
    const ledger = ledgerOf(served)
    const events: Array<BookEvent> = []
    for (const side of ["bid", "offer"] as const) {
      const sideLedger = ledger[side]
      const frame = frameOf(served, side, sideLedger.frames.at(-1))
      if (frame === undefined) continue
      sideLedger.frames.push(frame)
      events.push(
        ...(yield* read(served.code, side, sideLedger, ledger.trades))
      )
      prune(sideLedger)
    }
    return events
  })

  // Decision: a market phase change and a relay gap reset every code's
  // ledger: the frames and trades before them say nothing of the book after.
  // See spec apinrdw/kumora#517, "Book events".
  const reset = Effect.sync(() => codes.clear())

  return { trade, book, reset }
})
