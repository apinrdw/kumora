// The rules of walls, as a pure module: it joins `liveprice` matches to the tape and
// says which maker orders reached the whale threshold. `TradeRelay` stores and sends
// what comes out. Nothing here survives a restart but the walls already announced.
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type { Trade, Wall } from "@/domain/trade"

import {
  CASH_BOARD,
  NEGOTIATED_BOARD,
  REGULAR_BOARD,
  SHARES_PER_LOT,
} from "./exchange"
import type { RawLivePrice } from "./stockbit"
import { thresholdOf } from "./whale"
import type { Changes, WhaleState } from "./whale"

/** In code and not tuning targets. */
const WALL_GAP = 10
const WALL_WINDOW_MS = 1000
const WALL_IDLE_MS = 60_000
const JOIN_MS = 5000
const OFF_BOARDS: ReadonlySet<string> = new Set([CASH_BOARD, NEGOTIATED_BOARD])
const DATE_DIGITS = 8

/** One match of a maker order, as a `liveprice` frame saw it. */
export type MakerHit = {
  readonly symbol: Symbol
  readonly side: Wall["side"]
  readonly price: number
  readonly lots: number
  /** Exceeds 2^53, so it stays a string. */
  readonly orderNumber: string
  /** The WIB date, then the trade's number. */
  readonly matchNumber: string
  readonly receivedAt: IsoDateTime
}

/** A maker order on the way to a wall, or an announced wall. */
type Maker = {
  row: Wall
  announced: boolean
  firstSeenMs: number
  lastSeenMs: number
  /** Every match it has counted, as a resend can outlast the 5 s `seen` map. */
  readonly counted: Set<string>
  /** The trade that went through it, the last a delayed hit can come from while uncrossed. */
  closingNumber: number | null
}

/** One symbol's 5 s of frames and trades, and its makers. */
type JoinState = {
  /** Frames waiting for their trade, by the trade's number. */
  readonly held: Map<number, { hit: MakerHit; atMs: number }>
  /** Trades of the last 5 s, by number. A `Map` keeps arrival order, so pruning stops early. */
  readonly landed: Map<number, Trade>
  readonly seen: Map<string, number>
  /** When each order's first frame of the last 5 s arrived, its trade landed or not. */
  readonly heard: Map<string, IsoDateTime>
  readonly makers: Array<Maker>
  /** Which maker each order number belongs to. Gone walls stay, as their order can come back. */
  readonly byOrder: Map<string, Maker>
}

export type Walls = {
  readonly joins: Map<Symbol, JoinState>
  /**
   * The trade numbers of every symbol's trades that count on no wall, in coverage or not,
   * kept for the day the walls last. A frame naming one after its trade left the 5 s
   * `landed` map counts nothing.
   */
  readonly uncounted: Map<Symbol, Set<number>>
}

export const createWalls = (): Walls => ({
  joins: new Map(),
  uncounted: new Map(),
})

const isUncounted = (
  { uncounted }: Walls,
  symbol: Symbol,
  tradeNumber: number
) => uncounted.get(symbol)?.has(tradeNumber) ?? false

const markUncounted = (
  { uncounted }: Walls,
  { symbol, tradeNumber }: Trade
) => {
  let numbers = uncounted.get(symbol)
  if (!numbers) {
    numbers = new Set()
    uncounted.set(symbol, numbers)
  }
  numbers.add(tradeNumber)
}

const joinOf = ({ joins }: Walls, symbol: Symbol): JoinState => {
  let join = joins.get(symbol)
  if (!join) {
    join = {
      held: new Map(),
      landed: new Map(),
      seen: new Map(),
      heard: new Map(),
      makers: [],
      byOrder: new Map(),
    }
    joins.set(symbol, join)
  }
  return join
}

const SIDES: Readonly<Record<string, Wall["side"]>> = { S: "offer", B: "bid" }

/** The hit in a frame, if it says one. A frame with no match still moves the quote. */
export const makerHit = (
  symbol: Symbol,
  raw: RawLivePrice,
  receivedAt: IsoDateTime
): MakerHit | null => {
  const { lastprice, verb, quantity, orderNumber, matchNumber } = raw
  const side = verb === null ? undefined : SIDES[verb]
  if (
    lastprice === null ||
    side === undefined ||
    quantity === null ||
    orderNumber === null ||
    matchNumber === null
  )
    return null
  return {
    symbol,
    side,
    price: lastprice,
    lots: quantity / SHARES_PER_LOT,
    orderNumber,
    matchNumber,
    receivedAt,
  }
}

/** The WIB date a match number starts with, as a trading day. */
export const matchDay = (matchNumber: string) =>
  `${matchNumber.slice(0, 4)}-${matchNumber.slice(4, 6)}-${matchNumber.slice(6, DATE_DIGITS)}`

/** Below the date, where the number fits a double. */
const serial = (number: string) => Number(number.slice(DATE_DIGITS))

const isOpen = ({ row }: Maker) => row.closedAt === null

/** Only an RG trade with a known side moves a wall. NG is exempt from price limits. */
const isThrough = ({ row }: Maker, { board, side, price }: Trade) =>
  board === REGULAR_BOARD &&
  side !== "unspecified" &&
  (row.side === "offer" ? price > row.price : price < row.price)

/**
 * Frames are coalesced and the tape is not, so a hit can join after a trade that came
 * later on the tape and took its price. Trade numbers follow the tape's time; arrival does not.
 */
const tradedThroughSince = (join: JoinState, maker: Maker, number: number) => {
  for (const trade of join.landed.values())
    if (trade.tradeNumber > number && isThrough(maker, trade)) return trade
  return undefined
}

const forget = (join: JoinState, maker: Maker) => {
  join.makers.splice(join.makers.indexOf(maker), 1)
  for (const n of maker.row.memberOrderNumbers) {
    join.byOrder.delete(n)
    join.heard.delete(n)
  }
}

/** Open, or uncrossed and gone by a trade that came after this hit on the tape. */
const takesHit = (maker: Maker, hit: MakerHit) =>
  isOpen(maker) ||
  (!maker.announced &&
    maker.closingNumber !== null &&
    serial(hit.matchNumber) < maker.closingNumber)

const mergeInto = (join: JoinState, hit: MakerHit, firstHeardMs: number) =>
  join.makers.find(
    (m) =>
      takesHit(m, hit) &&
      m.row.side === hit.side &&
      m.row.price === hit.price &&
      Math.abs(firstHeardMs - m.firstSeenMs) <= WALL_WINDOW_MS &&
      m.row.memberOrderNumbers.some(
        (n) => Math.abs(serial(n) - serial(hit.orderNumber)) <= WALL_GAP
      )
  )

const newMaker = (
  hit: MakerHit,
  firstHeard: IsoDateTime,
  atMs: number,
  seq: number
): Maker => ({
  announced: false,
  firstSeenMs: Date.parse(firstHeard),
  lastSeenMs: atMs,
  counted: new Set(),
  closingNumber: null,
  row: {
    day: matchDay(hit.matchNumber),
    symbol: hit.symbol,
    side: hit.side,
    price: hit.price,
    firstOrderNumber: hit.orderNumber,
    memberOrderNumbers: [],
    hitsSeen: 0,
    lotsMatched: 0,
    threshold: 0,
    warmingUp: true,
    prior: "none",
    firstSeen: firstHeard,
    lastSeen: hit.receivedAt,
    closedAt: null,
    closedBy: null,
    seq,
  },
})

const goneIdle = (maker: Maker, nowMs: number) =>
  isOpen(maker) && nowMs - maker.lastSeenMs > WALL_IDLE_MS

/** Joins can complete out of arrival order, so a new member can be the earliest heard. */
const addMember = (
  maker: Maker,
  orderNumber: string,
  firstHeard: IsoDateTime
) => {
  const firstHeardMs = Date.parse(firstHeard)
  const earliest = firstHeardMs < maker.firstSeenMs
  maker.firstSeenMs = Math.min(maker.firstSeenMs, firstHeardMs)
  maker.row = {
    ...maker.row,
    firstSeen: earliest ? firstHeard : maker.row.firstSeen,
    memberOrderNumbers: [...maker.row.memberOrderNumbers, orderNumber],
  }
}

/** An unannounced maker past its idle deadline is forgotten here too, as no expiry may have run. */
const makerOf = (join: JoinState, hit: MakerHit, atMs: number, seq: number) => {
  const known = join.byOrder.get(hit.orderNumber)
  if (known?.announced) return known
  if (known && takesHit(known, hit) && !goneIdle(known, atMs)) return known
  if (known) forget(join, known)
  const firstHeard = join.heard.get(hit.orderNumber) ?? hit.receivedAt
  let maker = mergeInto(join, hit, Date.parse(firstHeard))
  if (!maker) {
    maker = newMaker(hit, firstHeard, atMs, seq)
    join.makers.push(maker)
  }
  addMember(maker, hit.orderNumber, firstHeard)
  join.byOrder.set(hit.orderNumber, maker)
  return maker
}

type Changed = Map<string, Wall>

const note = (changed: Changed, { row }: Maker) =>
  changed.set(`${row.symbol}:${row.firstOrderNumber}`, row)

const wallChanges = (changed: Changed): Changes => ({
  sweeps: [],
  walls: [...changed.values()],
  thresholds: [],
})

/**
 * A hit after an idle close proves the order still rests, so it reopens the wall. A
 * price that traded through is final, and a delayed hit says nothing about a newer close.
 */
const closureAfter = (
  { closedAt, closedBy }: Wall,
  atMs: number
): Pick<Wall, "closedAt" | "closedBy"> =>
  closedBy === "idle" && closedAt !== null && atMs > Date.parse(closedAt)
    ? { closedAt: null, closedBy: null }
    : { closedAt, closedBy }

/**
 * An announced wall stays, closed, on its row. An uncrossed maker a trade went through
 * waits out the join window for its delayed hits; one gone idle leaves no trace.
 */
const close = (
  join: JoinState,
  maker: Maker,
  closedBy: NonNullable<Wall["closedBy"]>,
  closedAt: IsoDateTime,
  seq: number,
  changed: Changed
) => {
  if (!maker.announced && closedBy === "idle") {
    forget(join, maker)
    return
  }
  maker.row = { ...maker.row, closedAt, closedBy, seq }
  if (maker.announced) note(changed, maker)
}

const closeThrough = (
  join: JoinState,
  maker: Maker,
  through: Trade,
  seq: number,
  changed: Changed
) => {
  maker.closingNumber = through.tradeNumber
  close(join, maker, "traded-through", through.receivedAt, seq, changed)
}

const countsOnWall = ({ board, side }: Trade) =>
  !OFF_BOARDS.has(board) && side !== "unspecified"

const announceIfCrossed = (
  whales: WhaleState,
  maker: Maker,
  { symbol, receivedAt }: MakerHit
) => {
  if (maker.announced) return
  const read = thresholdOf(whales, symbol, receivedAt)
  if (read.threshold === null || maker.row.lotsMatched < read.threshold) return
  maker.announced = true
  maker.row = {
    ...maker.row,
    threshold: read.threshold,
    warmingUp: read.warmingUp,
    prior: read.prior,
  }
}

const countHit = (
  join: JoinState,
  whales: WhaleState,
  hit: MakerHit,
  atMs: number,
  seq: number,
  changed: Changed
) => {
  const maker = makerOf(join, hit, atMs, seq)
  maker.counted.add(hit.matchNumber)
  const newest = atMs >= maker.lastSeenMs
  maker.lastSeenMs = Math.max(maker.lastSeenMs, atMs)
  maker.row = {
    ...maker.row,
    hitsSeen: maker.row.hitsSeen + 1,
    lotsMatched: maker.row.lotsMatched + hit.lots,
    lastSeen: newest ? hit.receivedAt : maker.row.lastSeen,
    ...closureAfter(maker.row, atMs),
    seq,
  }
  announceIfCrossed(whales, maker, hit)
  if (maker.announced) note(changed, maker)
  if (!isOpen(maker)) return
  const through = tradedThroughSince(join, maker, serial(hit.matchNumber))
  if (through) closeThrough(join, maker, through, seq, changed)
}

const pruneOld = <V>(
  map: Map<string | number, V>,
  atMsOf: (value: V) => number,
  nowMs: number
) => {
  for (const [key, value] of map) {
    if (nowMs - atMsOf(value) <= JOIN_MS) return
    map.delete(key)
  }
}

/** Takes one frame: it counts now if its trade has landed, and otherwise waits for it. */
export const feedHit = (
  walls: Walls,
  whales: WhaleState,
  hit: MakerHit,
  seq: number
): Changes => {
  const changed: Changed = new Map()
  const join = joinOf(walls, hit.symbol)
  const atMs = Date.parse(hit.receivedAt)
  if (
    join.seen.has(hit.matchNumber) ||
    join.byOrder.get(hit.orderNumber)?.counted.has(hit.matchNumber)
  )
    return wallChanges(changed)
  join.seen.set(hit.matchNumber, atMs)
  pruneOld(join.heard, Date.parse, atMs)
  if (!join.heard.has(hit.orderNumber))
    join.heard.set(hit.orderNumber, hit.receivedAt)
  const number = serial(hit.matchNumber)
  const landed = join.landed.get(number)
  if (!landed && !isUncounted(walls, hit.symbol, number))
    join.held.set(number, { hit, atMs })
  else if (landed && countsOnWall(landed))
    countHit(join, whales, hit, atMs, seq, changed)
  return wallChanges(changed)
}

const landTrade = (
  join: JoinState,
  whales: WhaleState,
  trade: Trade,
  seq: number,
  changed: Changed
) => {
  join.landed.set(trade.tradeNumber, trade)
  const waiting = join.held.get(trade.tradeNumber)
  if (waiting) {
    join.held.delete(trade.tradeNumber)
    if (countsOnWall(trade))
      countHit(join, whales, waiting.hit, waiting.atMs, seq, changed)
  }
  for (const maker of join.makers.filter(
    (m) => (isOpen(m) || m.row.closedBy === "idle") && isThrough(m, trade)
  ))
    closeThrough(join, maker, trade, seq, changed)
}

const awaitsTrades = ({ held, makers }: JoinState) =>
  held.size > 0 || makers.some(isOpen)

/** Takes a batch's fresh trades: the wall coverage's joins, and any symbol's open walls going. */
export const feedWallTrades = (
  walls: Walls,
  whales: WhaleState,
  trades: ReadonlyArray<Trade>,
  coverage: ReadonlySet<Symbol>,
  seq: number
): Changes => {
  const changed: Changed = new Map()
  for (const trade of trades) {
    if (!countsOnWall(trade)) markUncounted(walls, trade)
    const join = walls.joins.get(trade.symbol)
    if (!coverage.has(trade.symbol) && !(join && awaitsTrades(join))) continue
    landTrade(joinOf(walls, trade.symbol), whales, trade, seq, changed)
  }
  return wallChanges(changed)
}

const outlivedJoin = ({ announced, row }: Maker, nowMs: number) =>
  !announced &&
  row.closedAt !== null &&
  nowMs - Date.parse(row.closedAt) > JOIN_MS

/** Counts each frame whose trade never landed in 5 s, then ends the silent walls. */
export const expireWalls = (
  walls: Walls,
  whales: WhaleState,
  nowMs: number,
  seq: number
): Changes => {
  const changed: Changed = new Map()
  const at = new Date(nowMs).toISOString() as IsoDateTime
  for (const [symbol, join] of walls.joins) {
    for (const [number, { hit, atMs }] of join.held) {
      if (nowMs - atMs <= JOIN_MS) break
      join.held.delete(number)
      countHit(join, whales, hit, atMs, seq, changed)
    }
    pruneOld(join.landed, (t) => Date.parse(t.receivedAt), nowMs)
    pruneOld(join.seen, (atMs) => atMs, nowMs)
    pruneOld(join.heard, Date.parse, nowMs)
    for (const maker of join.makers.filter((m) => goneIdle(m, nowMs)))
      close(join, maker, "idle", at, seq, changed)
    for (const maker of join.makers.filter((m) => outlivedJoin(m, nowMs)))
      forget(join, maker)
    if (
      join.makers.length +
        join.held.size +
        join.landed.size +
        join.seen.size +
        join.heard.size ===
      0
    )
      walls.joins.delete(symbol)
  }
  return wallChanges(changed)
}

/** Puts today's announced walls back after a restart. Hits keep counting on their rows. */
export const restoreWalls = (walls: Walls, rows: ReadonlyArray<Wall>) => {
  for (const row of rows) {
    const join = joinOf(walls, row.symbol)
    const maker: Maker = {
      row,
      announced: true,
      firstSeenMs: Date.parse(row.firstSeen),
      lastSeenMs: Date.parse(row.lastSeen),
      counted: new Set(),
      closingNumber: null,
    }
    join.makers.push(maker)
    for (const n of row.memberOrderNumbers) join.byOrder.set(n, maker)
  }
}
