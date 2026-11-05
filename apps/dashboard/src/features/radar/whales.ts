// The radar's market-wide sweeps: a store over the `*` socket, folded by a pure
// reducer. No `effect` here, and the domain only as types.
import { useMemo, useSyncExternalStore } from "react"

import type {
  LeaderboardEntry,
  RelayStatus,
  Sweep,
  TapeProvenance,
  TradeFrame,
  Wall,
  WhalesToday,
} from "@/domain/trade"
import { createRelayStore } from "./relay-store"
import type { RelayEvent, RelaySocket } from "./relay-store"
import {
  demote,
  demoteProvenances,
  provenancesFromStatus,
  latest,
  sameSweep,
  sameWall,
  upsert,
  upsertWall,
} from "./tape"
import { MARKET, SWEEP_PAGE } from "@/relay/routes"

import { earlierSweeps, relayTicket, whalesToday } from "./query"

/** What a page left open keeps until the operator loads more. `earlier` walks back to whatever this drops. */
const KEEP = 2000
const LEADERBOARD_SIZE = 10

/** Where an opening socket is in its resume. Its frames are in `seq` order, up to `upTo`. The relay caps each list on its own. */
type Resume =
  | "none"
  | "awaiting-status"
  | { upTo: number; sweeps: number; walls: number }

export type WhalesState = {
  /** The resume point of the socket: the newest row heard, never a status's `seq`. */
  readonly seq: number
  readonly day: string | null
  readonly status: RelayStatus | null
  readonly socket: RelaySocket
  readonly provenance: TapeProvenance
  readonly liveprice: TapeProvenance
  /** The market's order: newest first, ties by symbol and number. */
  readonly sweeps: ReadonlyArray<Sweep>
  /** Set before the first `earlier` request: a live frame must not trim the tail it asks after, or the rows it brings. */
  readonly loadedEarlier: boolean
  readonly sweepsTotal: number
  /** Rows at or below this `seq` are in `sweepsTotal`, as the last status or paint counted it. */
  readonly countedSeq: number
  /** Every symbol seen, unsorted: the paint's totals plus each row's change since. */
  readonly leaderboard: ReadonlyArray<LeaderboardEntry>
  /** Rows at or below this `seq` are in the paint's totals, loaded or not. */
  readonly paintedSeq: number
  readonly walls: ReadonlyArray<Wall>
  readonly wallCoverage: WhalesToday["wallCoverage"]
  readonly thresholds: WhalesToday["thresholds"]
  readonly resume: Resume
  /** The last resume may have been capped, so the feed and the totals may have holes. */
  readonly gap: boolean
}

export const whalesState = (today: WhalesToday): WhalesState => ({
  seq: today.seq,
  day: today.day,
  status: null,
  socket: "idle",
  provenance: today.provenance,
  liveprice: today.liveprice,
  sweeps: today.sweeps,
  loadedEarlier: false,
  sweepsTotal: today.sweepsTotal,
  countedSeq: today.seq,
  leaderboard: today.leaderboard,
  paintedSeq: today.seq,
  walls: today.walls,
  wallCoverage: today.wallCoverage,
  thresholds: today.thresholds,
  resume: "none",
  gap: false,
})

const rollDay = (state: WhalesState, day: string | null): WhalesState => {
  if (day === null || day === state.day) return state
  return state.day === null || day > state.day
    ? {
        ...state,
        day,
        sweeps: [],
        loadedEarlier: false,
        sweepsTotal: 0,
        leaderboard: [],
        walls: [],
        thresholds: { symbols: 0, warmingUp: 0 },
      }
    : state
}

/** The browser's half of `MARKET_NEWEST_FIRST` in `relay/whale-store.ts`: `earlier`'s cursor needs both to agree. */
const newestFirst = (a: Sweep, b: Sweep) =>
  b.announcedAt.localeCompare(a.announcedAt) ||
  a.symbol.localeCompare(b.symbol) ||
  a.firstNumber - b.firstNumber

/** The leaderboard with a row's change added. A row it has never seen counts whole. */
const addToLeaderboard = (
  leaderboard: ReadonlyArray<LeaderboardEntry>,
  { symbol, side }: Sweep,
  change: number
) => {
  if (change === 0) return leaderboard
  const held = leaderboard.find((e) => e.symbol === symbol) ?? {
    symbol,
    buyValue: 0,
    sellValue: 0,
  }
  const entry =
    side === "buy"
      ? { ...held, buyValue: held.buyValue + change }
      : { ...held, sellValue: held.sellValue + change }
  return [...leaderboard.filter((e) => e.symbol !== symbol), entry]
}

export const hasEarlier = ({ sweeps, sweepsTotal }: WhalesState) =>
  sweeps.length < sweepsTotal

/**
 * Behind a page with more rows past it: already in the totals, and with no baseline to take a
 * change from. Holding it would make it the tail, and `earlier` would skip the rows between.
 */
const pastLoadedPage = (state: WhalesState, sweep: Sweep) => {
  const tail = state.sweeps.at(-1)
  return tail !== undefined && hasEarlier(state) && newestFirst(sweep, tail) > 0
}

/** A refetch can move to the next day while the socket still drains the old day's resume. */
const beforeStateDay = (state: WhalesState, { day }: { day: string | null }) =>
  day !== null && state.day !== null && day < state.day

/** `seq` does not order a row's versions: an idle close or a `liveprice` hit leaves it alone. */
const compareSweepVersions = (a: Sweep, b: Sweep) =>
  Date.parse(a.updatedAt) - Date.parse(b.updatedAt)

const wallChangedAt = ({ lastSeen, closedAt }: Wall) =>
  Math.max(Date.parse(lastSeen), closedAt === null ? 0 : Date.parse(closedAt))

/** A delayed hit moves neither time, so `hitsSeen`, which only rises, orders it. */
const compareWallVersions = (a: Wall, b: Wall) =>
  wallChangedAt(a) - wallChangedAt(b) || a.hitsSeen - b.hitsSeen

const foldSweep = (state: WhalesState, sweep: Sweep): WhalesState => {
  if (beforeStateDay(state, sweep)) return state
  const rolled = rollDay(state, sweep.day)
  const held = rolled.sweeps.find(sameSweep(sweep))
  const dropped = held
    ? compareSweepVersions(sweep, held) < 0
    : pastLoadedPage(rolled, sweep)
  if (dropped) return rolled
  const painted = sweep.seq <= rolled.paintedSeq
  const counted = held !== undefined || sweep.seq <= rolled.countedSeq
  const sweeps = upsert(rolled.sweeps, sweep, sameSweep(sweep), newestFirst)
  return {
    ...rolled,
    sweeps: rolled.loadedEarlier ? sweeps : sweeps.slice(0, KEEP),
    sweepsTotal: rolled.sweepsTotal + (counted ? 0 : 1),
    leaderboard: addToLeaderboard(
      rolled.leaderboard,
      sweep,
      held ? sweep.value - held.value : painted ? 0 : sweep.value
    ),
  }
}

const foldWall = (state: WhalesState, wall: Wall): WhalesState => {
  if (beforeStateDay(state, wall)) return state
  const rolled = rollDay(state, wall.day)
  const held = rolled.walls.find(sameWall(wall))
  if (held && compareWallVersions(wall, held) < 0) return rolled
  return { ...rolled, walls: upsertWall(rolled.walls, wall) }
}

/** Counts a row of the resume. A full one means the relay had more than it sent. */
const countResumed = (
  state: WhalesState,
  list: "sweeps" | "walls",
  seq: number
): WhalesState => {
  const { resume } = state
  if (typeof resume === "string") return state
  if (seq > resume.upTo) return { ...state, resume: "none" }
  const rows = resume[list] + 1
  return rows < SWEEP_PAGE
    ? { ...state, resume: { ...resume, [list]: rows } }
    : { ...state, resume: "none", gap: true }
}

const onSweep = (
  state: WhalesState,
  frame: Extract<TradeFrame, { type: "sweep" }>
): WhalesState => {
  const folded = countResumed(
    foldSweep(state, frame.sweep),
    "sweeps",
    frame.sweep.seq
  )
  return {
    ...folded,
    seq: Math.max(folded.seq, frame.seq),
    provenance: latest(folded.provenance, frame.provenance),
  }
}

const onWall = (
  state: WhalesState,
  frame: Extract<TradeFrame, { type: "wall" }>
): WhalesState => {
  const folded = countResumed(
    foldWall(state, frame.wall),
    "walls",
    frame.wall.seq
  )
  return {
    ...folded,
    seq: Math.max(folded.seq, frame.seq),
    liveprice: latest(folded.liveprice, frame.provenance),
  }
}

/** The first status on a socket says how far the resume runs, and how many new rows it missed. */
const startResume = (
  state: WhalesState,
  status: RelayStatus,
  missed: number
): WhalesState =>
  state.resume === "awaiting-status"
    ? {
        ...state,
        resume: { upTo: status.seq, sweeps: 0, walls: 0 },
        gap: state.gap || missed >= SWEEP_PAGE,
      }
    : state

/**
 * A refetch can land while the socket still drains frames the relay queued before it. An equal
 * `seq` is not older: an idle close changes the counts without bumping it.
 */
const olderThanAccepted = (state: WhalesState, status: RelayStatus) =>
  status.seq < state.countedSeq || beforeStateDay(state, status)

const onStatus = (state: WhalesState, status: RelayStatus): WhalesState => {
  if (olderThanAccepted(state, status)) return startResume(state, status, 0)
  const stepped = rollDay(state, status.day)
  const rolled = startResume(
    stepped,
    status,
    status.sweeps - stepped.sweepsTotal
  )
  return {
    ...rolled,
    status,
    sweepsTotal: status.sweeps,
    countedSeq: status.seq,
    wallCoverage: status.wallCoverage,
    thresholds: status.thresholds,
    ...provenancesFromStatus(rolled, status),
  }
}

const onFrame = (state: WhalesState, frame: TradeFrame): WhalesState => {
  switch (frame.type) {
    case "status":
      return onStatus(state, frame.status)
    case "sweep":
      return onSweep(state, frame)
    case "wall":
      return onWall(state, frame)
    case "threshold":
      return { ...state, seq: Math.max(state.seq, frame.seq) }
    // The relay sends the market neither.
    case "trades":
    case "quote":
      return state
  }
}

export const reduceWhales = (
  state: WhalesState,
  event: RelayEvent
): WhalesState => {
  switch (event.type) {
    case "frame":
      return onFrame(state, event.frame)
    case "socket":
      return {
        ...state,
        socket: event.socket,
        resume: event.socket === "open" ? "awaiting-status" : state.resume,
        provenance:
          event.socket === "closed"
            ? demote(state.provenance)
            : state.provenance,
        liveprice:
          event.socket === "closed" ? demote(state.liveprice) : state.liveprice,
      }
    case "silent":
      return demoteProvenances(state)
  }
}

/** Older rows of the same day, already in the totals: a page never moves the leaderboard or the count. */
export const addEarlier = (
  state: WhalesState,
  rows: ReadonlyArray<Sweep>
): WhalesState => {
  const known = rows.filter(
    (row) => row.day === state.day && !state.sweeps.some(sameSweep(row))
  )
  return known.length
    ? {
        ...state,
        sweeps: [...state.sweeps, ...known].sort(newestFirst),
      }
    : state
}

/** Rows the snapshot does not already know better. A tie is the snapshot's. */
const heldOver = <Row extends { readonly seq: number; readonly day: string }>(
  held: ReadonlyArray<Row>,
  painted: ReadonlyArray<Row>,
  same: (a: Row) => (b: Row) => boolean,
  compareVersions: (a: Row, b: Row) => number,
  today: WhalesToday
) =>
  held.filter((row) => {
    if (row.day !== today.day) return false
    const theirs = painted.find(same(row))
    return theirs ? compareVersions(row, theirs) > 0 : row.seq >= today.seq
  })

/**
 * Back to a contiguous newest page and true totals. Rows it lacks at or past its `seq`, and
 * rows newer than its own, are folded back on; the rows the operator had loaded go. A snapshot
 * of an earlier day changes nothing, so `gap` stays set and the next event asks again.
 */
export const resetToToday = (
  state: WhalesState,
  today: WhalesToday
): WhalesState => {
  if (today.day !== null && state.day !== null && today.day < state.day)
    return state
  const painted: WhalesState = {
    ...whalesState(today),
    seq: Math.max(today.seq, state.seq),
    status: state.status,
    socket: state.socket,
    provenance:
      state.socket === "open" ? today.provenance : demote(today.provenance),
    liveprice:
      state.socket === "open" ? today.liveprice : demote(today.liveprice),
  }
  const sweeps = heldOver(
    state.sweeps,
    today.sweeps,
    sameSweep,
    compareSweepVersions,
    today
  )
  const walls = heldOver(
    state.walls,
    today.walls,
    sameWall,
    compareWallVersions,
    today
  )
  return walls.reduce(foldWall, sweeps.reduce(foldSweep, painted))
}

export const mostSwept = ({ leaderboard }: WhalesState) =>
  [...leaderboard]
    .sort((a, b) => b.buyValue + b.sellValue - (a.buyValue + a.sellValue))
    .slice(0, LEADERBOARD_SIZE)

export const createWhalesStore = (today: WhalesToday) => {
  let refetching = false
  /** Bumped by each reset, so a page asked for before one cannot land after it. */
  let resets = 0
  const refetch = async () => {
    if (refetching) return
    refetching = true
    // A failure leaves `gap` set: the next event asks again.
    const fresh = await whalesToday().catch(() => null)
    refetching = false
    if (fresh === null) return
    const held = store.getSnapshot()
    const reset = resetToToday(held, fresh)
    if (reset === held) return
    resets++
    endedAt = null
    store.update(() => reset)
  }
  const store = createRelayStore<WhalesState>({
    symbol: MARKET,
    initial: whalesState(today),
    reduce: reduceWhales,
    ticket: () => relayTicket({ data: { symbol: MARKET } }),
    afterEvent: ({ gap }) => {
      if (gap) void refetch()
    },
  })
  let loading = false
  /** The row after which the relay had no more, whatever the count says. A new day moves on from it. */
  let endedAt: Sweep | null = null
  return {
    ...store,
    loadEarlier: async () => {
      const state = store.getSnapshot()
      const tail = state.sweeps.at(-1)
      if (loading || !tail || tail === endedAt || !hasEarlier(state)) return
      loading = true
      store.update((s) => ({ ...s, loadedEarlier: true }))
      const asked = resets
      const { day, announcedAt, symbol, firstNumber } = tail
      // A failed page stays unloaded: the next scroll asks again.
      const rows = await earlierSweeps({
        data: { day, announcedAt, symbol, firstNumber },
      }).catch(() => null)
      loading = false
      if (rows === null || asked !== resets) return
      if (rows.length === 0) endedAt = tail
      store.update((s) => addEarlier(s, rows))
    },
  }
}

/** Today's sweeps across the market, seeded from the radar loader. */
export const useWhales = (today: WhalesToday) => {
  const store = useMemo(() => createWhalesStore(today), [today])
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
  return { state, loadEarlier: store.loadEarlier }
}
