// The rules of sweeps, as a pure module: it reads aggressor orders back out of the
// tape and judges each against its symbol's whale threshold. `TradeRelay` stores
// and sends what comes out. Walls are in the sibling `whale-walls.ts`.
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type {
  Sweep,
  ThresholdPrior,
  ThresholdState,
  Trade,
  Wall,
} from "@/domain/trade"

import { REGULAR_BOARD, SHARES_PER_LOT } from "./exchange"
import { ORDER_CLOSE_MS, THRESHOLD_PERCENTILE } from "./routes"
import { tradingDay } from "./trading-day"

/** In code and not tuning targets: a stored prior cannot be re-bucketed. */
const PRIOR_WEIGHT = 1000
const WARM_ORDERS = 1000
const GAMMA = 1.02
/** Covers 1 to 10^7 lots. */
const BUCKETS = 815

/** A symbol's aggressor-order lots this session, or a session's before it. */
export type Sketch = {
  buckets: Uint32Array
  /** How many orders it holds. */
  n: number
  /** The last trade of the last order inserted, which a rebuild applies only above. */
  lastNumber: number
}

/** The most recent earlier session. A symbol that did not trade in it falls to `market`. */
export type Priors = {
  readonly own: ReadonlyMap<Symbol, Sketch>
  readonly market: Sketch | null
}

type OpenOrder = {
  readonly symbol: Symbol
  readonly side: "buy" | "sell"
  readonly board: string
  readonly tradedAt: IsoDateTime
  readonly firstNumber: number
  /** The batch of its first trade, which a rebuild has to start from. */
  readonly firstSeq: number
  /** Read before its first trade, and kept for its life. */
  readonly judgedBy: ThresholdState
  lastNumber: number
  lots: number
  value: number
  freq: number
  priceLow: number
  priceHigh: number
  lastReceivedMs: number
  announcedAt: IsoDateTime | null
}

export type WhaleState = {
  readonly priors: Priors
  readonly sketches: Map<Symbol, Sketch>
  readonly open: Map<Symbol, OpenOrder>
  /** Symbols whose sketch changed since the last flush. */
  readonly dirty: Set<Symbol>
  /** Dropped when the symbol's sketch changes. */
  readonly cache: Map<Symbol, Pick<ThresholdState, "threshold" | "prior">>
}

/** The rows that changed, each once in its last state. */
export type Changes = {
  readonly sweeps: ReadonlyArray<Sweep>
  readonly walls: ReadonlyArray<Wall>
  /** The symbols whose sketch changed, so whose threshold may have. */
  readonly thresholds: ReadonlyArray<Symbol>
}

const NO_PRIORS: Priors = { own: new Map(), market: null }

export const createWhales = (
  priors: Priors = NO_PRIORS,
  today: ReadonlyMap<Symbol, Sketch> = new Map()
): WhaleState => ({
  priors,
  sketches: new Map(today),
  open: new Map(),
  dirty: new Set(),
  cache: new Map(),
})

const emptySketch = (): Sketch => ({
  buckets: new Uint32Array(BUCKETS),
  n: 0,
  lastNumber: 0,
})

const bucketOf = (lots: number) =>
  Math.min(
    BUCKETS - 1,
    Math.max(0, Math.ceil(Math.log(lots) / Math.log(GAMMA)))
  )

const bucketValue = (i: number) => Math.round((2 * GAMMA ** i) / (GAMMA + 1))

const insert = (sketch: Sketch, lots: number) => {
  const i = bucketOf(lots)
  sketch.buckets[i] = (sketch.buckets[i] ?? 0) + 1
  sketch.n++
}

export const sketchOf = (lots: ReadonlyArray<number>): Sketch => {
  const sketch = emptySketch()
  for (const l of lots) insert(sketch, l)
  return sketch
}

/** A copy, as workerd binds and returns a BLOB: an `ArrayBuffer`. */
export const sketchBytes = ({ buckets }: Sketch): ArrayBuffer =>
  buckets.slice().buffer

export const bucketsFromBytes = (bytes: ArrayBuffer) => new Uint32Array(bytes)

/** The sum of all symbols, which a symbol that did not trade falls back to. */
export const marketSketch = (sketches: Iterable<Sketch>): Sketch => {
  const market = emptySketch()
  for (const { buckets, n } of sketches) {
    market.n += n
    for (let i = 0; i < BUCKETS; i++)
      market.buckets[i] = (market.buckets[i] ?? 0) + (buckets[i] ?? 0)
  }
  return market
}

const priorOf = (
  { own, market }: Priors,
  symbol: Symbol
): { prior: ThresholdPrior; sketch: Sketch | null } => {
  const mine = own.get(symbol)
  if (mine?.n) return { prior: "own", sketch: mine }
  if (market?.n) return { prior: "market", sketch: market }
  return { prior: "none", sketch: null }
}

/** The first bucket whose cumulative mass reaches the target. The prior makes it fractional. */
const query = (today: Sketch | undefined, prior: Sketch | null) => {
  const weight = prior ? PRIOR_WEIGHT / prior.n : 0
  const mass = (i: number) =>
    (today?.buckets[i] ?? 0) + (prior?.buckets[i] ?? 0) * weight
  const total = (today?.n ?? 0) + (prior ? PRIOR_WEIGHT : 0)
  if (total === 0) return null
  const target = THRESHOLD_PERCENTILE * total
  let cumulative = 0
  let last = 0
  for (let i = 0; i < BUCKETS; i++) {
    const here = mass(i)
    if (here === 0) continue
    cumulative += here
    last = i
    if (cumulative >= target) return bucketValue(i)
  }
  return bucketValue(last)
}

/** Reading a symbol never seen creates nothing. */
export const thresholdOf = (
  whales: WhaleState,
  symbol: Symbol,
  asOf: ThresholdState["asOf"]
): ThresholdState => {
  const today = whales.sketches.get(symbol)
  let cached = whales.cache.get(symbol)
  if (!cached) {
    const { prior, sketch } = priorOf(whales.priors, symbol)
    cached = { threshold: query(today, sketch), prior }
    whales.cache.set(symbol, cached)
  }
  const ordersToday = today?.n ?? 0
  return {
    symbol,
    ...cached,
    warmingUp: ordersToday < WARM_ORDERS,
    ordersToday,
    asOf,
  }
}

/** The symbols known to have a threshold, and how many of them are still warming up. */
export const thresholdCounts = (whales: WhaleState) => {
  let symbols = 0
  let warmingUp = 0
  for (const symbol of new Set([
    ...whales.sketches.keys(),
    ...whales.priors.own.keys(),
  ])) {
    const state = thresholdOf(whales, symbol, null)
    if (state.threshold === null) continue
    symbols++
    if (state.warmingUp) warmingUp++
  }
  return { symbols, warmingUp }
}

const sweepRow = (
  order: OpenOrder,
  announcedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedBy: Sweep["closedBy"],
  seq: number
): Sweep | null => {
  const { threshold, warmingUp, prior } = order.judgedBy
  if (threshold === null) return null
  return {
    day: tradingDay(order.tradedAt),
    symbol: order.symbol,
    firstNumber: order.firstNumber,
    lastNumber: order.lastNumber,
    side: order.side,
    board: order.board,
    tradedAt: order.tradedAt,
    lots: order.lots,
    value: order.value,
    freq: order.freq,
    priceLow: order.priceLow,
    priceHigh: order.priceHigh,
    threshold,
    warmingUp,
    prior,
    open: closedBy === null,
    closedBy,
    announcedAt,
    updatedAt,
    seq,
  }
}

type Changed = {
  /** Keyed by first number, so a later state of the same row replaces its earlier one. */
  readonly sweeps: Map<string, Sweep>
  readonly thresholds: Set<Symbol>
}

const noChanges = (): Changed => ({ sweeps: new Map(), thresholds: new Set() })

const noteSweep = (changed: Changed, sweep: Sweep | null) => {
  if (sweep) changed.sweeps.set(`${sweep.symbol}:${sweep.firstNumber}`, sweep)
}

const closeOrder = (
  whales: WhaleState,
  order: OpenOrder,
  closedBy: "next-order" | "idle",
  at: IsoDateTime,
  seq: number,
  changed: Changed
) => {
  whales.open.delete(order.symbol)
  let sketch = whales.sketches.get(order.symbol)
  if (!sketch) {
    sketch = emptySketch()
    whales.sketches.set(order.symbol, sketch)
  }
  insert(sketch, order.lots)
  sketch.lastNumber = order.lastNumber
  whales.dirty.add(order.symbol)
  whales.cache.delete(order.symbol)
  changed.thresholds.add(order.symbol)
  if (order.announcedAt)
    noteSweep(changed, sweepRow(order, order.announcedAt, at, closedBy, seq))
}

const isIdle = ({ lastReceivedMs }: OpenOrder, nowMs: number) =>
  nowMs - lastReceivedMs > ORDER_CLOSE_MS

/** Only an RG trade with a known side is part of an aggressor order. */
const aggressorSide = ({ board, side }: Trade) =>
  board === REGULAR_BOARD && side !== "unspecified" ? side : null

/** The deadline comes first, so a late trade ends the order even if no idle close ran. */
const closeEnded = (
  whales: WhaleState,
  { symbol, tradedAt, receivedAt }: Trade,
  side: OpenOrder["side"],
  seq: number,
  changed: Changed
) => {
  const current = whales.open.get(symbol)
  if (!current) return
  if (isIdle(current, Date.parse(receivedAt)))
    closeOrder(whales, current, "idle", receivedAt, seq, changed)
  else if (current.side !== side || current.tradedAt !== tradedAt)
    closeOrder(whales, current, "next-order", receivedAt, seq, changed)
}

const feedTrade = (
  whales: WhaleState,
  trade: Trade,
  seq: number,
  changed: Changed
) => {
  const side = aggressorSide(trade)
  if (side === null) return
  const { symbol, tradedAt, receivedAt, tradeNumber, price } = trade
  closeEnded(whales, trade, side, seq, changed)
  let order = whales.open.get(symbol)
  if (!order) {
    order = {
      symbol,
      side,
      board: trade.board,
      tradedAt,
      firstNumber: tradeNumber,
      firstSeq: seq,
      judgedBy: thresholdOf(whales, symbol, receivedAt),
      lastNumber: tradeNumber,
      lots: 0,
      value: 0,
      freq: 0,
      priceLow: price,
      priceHigh: price,
      lastReceivedMs: 0,
      announcedAt: null,
    }
    whales.open.set(symbol, order)
  }
  order.lastNumber = tradeNumber
  order.lots += trade.volume / SHARES_PER_LOT
  order.value += trade.value
  order.freq++
  order.priceLow = Math.min(order.priceLow, price)
  order.priceHigh = Math.max(order.priceHigh, price)
  order.lastReceivedMs = Date.parse(receivedAt)
  const { threshold } = order.judgedBy
  if (threshold === null || order.lots < threshold) return
  order.announcedAt ??= receivedAt
  noteSweep(changed, sweepRow(order, order.announcedAt, receivedAt, null, seq))
}

const changes = ({ sweeps, thresholds }: Changed): Changes => ({
  sweeps: [...sweeps.values()],
  walls: [],
  thresholds: [...thresholds],
})

/** Feeds a batch's fresh trades. A batch boundary never closes an order. */
export const feedTrades = (
  whales: WhaleState,
  trades: ReadonlyArray<Trade>,
  seq: number
): Changes => {
  const changed = noChanges()
  for (const trade of trades) feedTrade(whales, trade, seq, changed)
  return changes(changed)
}

/** Closes every open order whose last trade arrived more than `ORDER_CLOSE_MS` ago. */
export const closeIdle = (
  whales: WhaleState,
  nowMs: number,
  seq: number
): Changes => {
  const changed = noChanges()
  const at = new Date(nowMs).toISOString() as IsoDateTime
  for (const order of whales.open.values())
    if (isIdle(order, nowMs))
      closeOrder(whales, order, "idle", at, seq, changed)
  return changes(changed)
}

/** The day's end. Its rows are about to go, so only the sketches hear of these closes. */
export const closeAll = (whales: WhaleState, at: IsoDateTime, seq: number) => {
  const changed = noChanges()
  for (const order of whales.open.values())
    closeOrder(whales, order, "idle", at, seq, changed)
}

/** The batch a rebuild has to start from: the oldest open order's, or the next one. */
export const whaleReplayFrom = (whales: WhaleState, seq: number) =>
  Math.min(seq + 1, ...[...whales.open.values()].map((order) => order.firstSeq))

/** Above the sketch's last number: anything at or below is in the sketch already. */
export const notInSketch = (whales: WhaleState, trades: ReadonlyArray<Trade>) =>
  trades.filter(
    ({ symbol, tradeNumber }) =>
      tradeNumber > (whales.sketches.get(symbol)?.lastNumber ?? 0)
  )
