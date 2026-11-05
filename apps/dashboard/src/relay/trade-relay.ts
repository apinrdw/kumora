// The one Durable Object that takes raw Stockbit frames from an ingest, keeps the
// current trading day's tape, and fans trades out per symbol. A thin shell: its
// decisions live in the pure modules beside it. It hibernates between messages,
// so everything in memory here is rebuilt by load() or safe to lose.
import { DurableObject } from "cloudflare:workers"

import { isSymbol } from "@/domain/symbol-guard"
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type {
  LiveSymbol,
  RelayStatus,
  Sweep,
  SweepCursor,
  TapeBackfill,
  TapeProvenance,
  Trade,
  TradeFrame,
  TradeSource,
  WhalesToday,
  Wall,
} from "@/domain/trade"

import { calendarOutOfDate, nextOpen, phaseAt } from "./calendar"
import { calendarFrom } from "./calendar-override"
import { LIVE_MS, relayFreshness } from "./freshness"
import { OWN_SESSION, ingestIsSilent, selectSource } from "./source"
import type { Ingest } from "./source"
import { LiveQuotes } from "./live-quotes"
import { openingFrames } from "./opening-frames"
import {
  NO_QUOTE,
  SYMBOL_TAG,
  lastRgTrade,
  wallCoverageFrom,
  openSymbols,
} from "./quote"
import type { IngestControl, IngestMessage } from "./ingest-control"
import {
  INGEST_CLOSE,
  INGEST_PATH,
  INGEST_PROTOCOL,
  MARKET,
  OFF_BOARD_KEEP,
  PING,
  PONG,
  SWEEP_PAGE,
  TAPE_KEEP,
  TRADES_QUERY,
} from "./routes"
import { lastRgOf, relayStore } from "./store"
import { COALESCED, decodeWrap, unpackCoalesced } from "./stockbit"
import type { RawLivePrice, RawTrade, WrapFrame } from "./stockbit"
import { dedupe, groupBySymbol, keepCurrentDay, toTrades } from "./tape"
import { sameSecret } from "./ticket"
import { tradingDay } from "./trading-day"
import { wakeAt } from "./upstream"
import {
  closeIdle,
  createWhales,
  feedTrades,
  thresholdCounts,
  thresholdOf,
} from "./whale"
import type { Changes } from "./whale"
import {
  endWhaleSession,
  flushWhales,
  rebuildWhales,
  WHALE_REPLAY_KEY,
} from "./whale-persistence"
import {
  createWalls,
  expireWalls,
  feedHit,
  feedWallTrades,
  makerHit,
  matchDay,
  restoreWalls,
} from "./whale-walls"
import { NO_CANDLES, foldCandles } from "./candles"
import { OwnSession, connectStockbit, sqlOwnSessionStore } from "./own-session"
import { watchdog } from "./watchdog"
import type { Watchdog } from "./watchdog"

/** Rows a reconnecting client may be sent; each row is one symbol's slice of a batch. */
const RESUME_ROWS = 500
const ALARM_MS = 30_000
const ACTIVE_KEY = "active"
/** What the last status push said, so the alarm pushes only a change. */
const PUSHED_KEY = "pushed"
const WATCHDOG_KEY = "watchdog"
/** How long a new socket has to send its auth message. */
export const AUTH_MS = 5000
const LIVEPRICE_DEBOUNCE_MS = 500
const THRESHOLD_FRAME_MS = 10_000
/** The tag of the whale radar's socket. Not a `sym:` tag: those build the wall coverage. */
const MARKET_TAG = "market"

/**
 * An ingest socket's attachment. Before its auth it is no ingest yet: nothing counts it.
 * A refused one never becomes one.
 */
type IngestSocket = Ingest & {
  readonly auth: "pending" | "authenticated" | "refused"
}

const ingestOf = (ws: WebSocket) => ws.deserializeAttachment() as IngestSocket

/** Marks the refusal before the close, since the socket can still deliver what it queued. */
const refuse = (ws: WebSocket, code: number, reason: string) => {
  ws.serializeAttachment({
    ...ingestOf(ws),
    auth: "refused",
  } satisfies IngestSocket)
  ws.close(code, reason)
}

/** An ingest's text message, or null when it is not a JSON object. */
const ingestMessage = (message: string): Partial<IngestMessage> | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return null
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Partial<IngestMessage>)
    : null
}

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ relay: event, ...fields }))

export class TradeRelay extends DurableObject<Env> {
  private calendar = calendarFrom(this.env.RELAY_CALENDAR)
  private store = relayStore(this.ctx.storage.sql)
  private quotes = new LiveQuotes(this.store)
  private last = new Map<Symbol, number>()
  /** Never reset, across days too: a client resumes from the seq it last saw. */
  private seq = 0
  private day: string | null = null
  private lastTradeAt: IsoDateTime | null = null
  private trades = 0
  /** Since this wake only; reported in the alarm summary. */
  private skipped = 0
  private pushed: string | null = null
  private livepriceTimer: ReturnType<typeof setTimeout> | null = null
  private ownSession: OwnSession
  private whales = createWhales()
  /** Counted here because the status is read on every batch. */
  private sweepCount = 0
  /** What each symbol's page last heard, in memory: losing it costs an extra frame. */
  private thresholdSent = new Map<Symbol, { at: number; said: string }>()
  private thresholdsDue = new Set<Symbol>()
  private walls = createWalls()
  private wallCount = 0
  /** When each symbol's last `liveprice` frame arrived, in memory. Its frames come soon again. */
  private lastLiveAt = new Map<Symbol, number>()
  /** The watched list the relay last received. Nothing sends one now; it stays as last sent. Mirrors `wall_symbols`. */
  private wallSymbols: ReadonlyArray<Symbol> = []
  /** The own session has no close event: its leaving `live` is what flushes. */
  private ownSessionWasLive = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
    this.load()
    this.ownSession = new OwnSession({
      store: sqlOwnSessionStore(ctx.storage),
      now: () => Date.now(),
      open: (now) => phaseAt(now, this.calendar) !== "closed",
      symbols: () => this.wallCoverageSymbols(),
      connect: connectStockbit,
      askCredential: () => this.toIngests({ type: "credential-needed" }),
      credentialOk: () => this.toIngests({ type: "credential-ok" }),
      credentialStop: () => this.toIngests({ type: "credential-stop" }),
      onFrame: (frame) => this.ingestFrame(frame),
      onChange: () => {
        this.flushWhenOwnSessionStops()
        this.reselect()
        this.broadcastStatus()
      },
      log,
    })
    this.ownSession.restart()
  }

  /** Reads `symbol_state`, at most about 850 rows, and `tape` only per symbol. It must not scan it. */
  private load() {
    this.store.create()
    this.pushed = this.ctx.storage.kv.get<string>(PUSHED_KEY) ?? null
    this.wallSymbols = this.store.wallSymbols()
    const states = this.loadSymbolStates()
    const replayFrom = this.replayBoundary()
    if (this.day === null) return
    const replayed = states
      .filter((row) => row.last_seq >= replayFrom)
      .map((row) => row.symbol)
    // Fan-out stays off: `ownSession`, which a frame's provenance reads, does not exist yet.
    this.whales = rebuildWhales(this.store, this.day, replayed, replayFrom)
    this.sweepCount = this.store.sweepCount(this.day)
    this.reloadWalls()
  }

  /** No key means no whale state to rebuild, and replaying the whole tape could exhaust memory. */
  private replayBoundary() {
    const stored = this.ctx.storage.kv.get<number>(WHALE_REPLAY_KEY)
    if (stored !== undefined) return stored
    // Stored now: a wake before the first flush must replay what this one goes on to process.
    const boundary = this.seq + 1
    this.ctx.storage.kv.put(WHALE_REPLAY_KEY, boundary)
    return boundary
  }

  private loadSymbolStates() {
    const states = this.store.symbolStates().toArray()
    for (const row of states) {
      this.last.set(row.symbol, row.last_number)
      const rg = lastRgOf(row)
      if (rg) this.quotes.setRg(row.symbol, rg)
      this.seq = Math.max(this.seq, row.last_seq)
      this.trades += row.trades
      if (this.day === null || row.day > this.day) this.day = row.day
      if (this.lastTradeAt === null || row.last_received_at > this.lastTradeAt)
        this.lastTradeAt = row.last_received_at
    }
    return states
  }

  // ── sockets ────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    await this.ensureAlarm()
    const url = new URL(request.url)
    if (url.pathname === INGEST_PATH) {
      const { 0: client, 1: server } = new WebSocketPair()
      this.acceptIngest(server)
      await this.ensureAlarm(Date.now() + AUTH_MS)
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { "Sec-WebSocket-Protocol": INGEST_PROTOCOL },
      })
    }
    const symbol = url.searchParams.get(TRADES_QUERY.symbol)
    if (symbol !== MARKET && !isSymbol(symbol))
      return new Response("bad symbol", { status: 400 })
    const { 0: client, 1: server } = new WebSocketPair()
    const since = Number(url.searchParams.get(TRADES_QUERY.since)) || 0
    if (symbol === MARKET) this.acceptMarket(server, since)
    else this.acceptClient(server, symbol, since)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Heard from only once its first message, an `auth`, carries the ingest secret. */
  private acceptIngest(server: WebSocket) {
    const ingest: IngestSocket = {
      id: crypto.randomUUID(),
      connectedAt: Date.now(),
      // Not a source until it says so, in the `datafeed` message it sends on connect.
      datafeed: false,
      auth: "pending",
      install: null,
    }
    this.ctx.acceptWebSocket(server, ["ingest"])
    server.serializeAttachment(ingest)
    log("ingest-connected", { id: ingest.id })
  }

  /** A socket's first message on the ingest path. Anything but the right secret closes it. */
  private authenticate(ws: WebSocket, message: string | ArrayBuffer) {
    const ingest = ingestOf(ws)
    if (!this.isAuth(message)) {
      log("ingest-refused", { id: ingest.id })
      refuse(ws, INGEST_CLOSE.unauthorized, "unauthorized")
      return
    }
    ws.serializeAttachment({
      ...ingest,
      auth: "authenticated",
    } satisfies IngestSocket)
    ws.send(JSON.stringify({ type: "pause" } satisfies IngestControl))
    if (this.ownSession.needsCredential)
      ws.send(
        JSON.stringify({ type: "credential-needed" } satisfies IngestControl)
      )
    log("ingest-authenticated", { id: ingest.id })
    this.reselect()
    this.broadcastStatus()
  }

  private isAuth(message: string | ArrayBuffer) {
    if (typeof message !== "string") return false
    const parsed = ingestMessage(message)
    return (
      parsed?.type === "auth" &&
      typeof parsed.secret === "string" &&
      sameSecret(parsed.secret, this.env.RELAY_INGEST_SECRET)
    )
  }

  private acceptClient(server: WebSocket, symbol: Symbol, since: number) {
    this.ctx.acceptWebSocket(server, ["client", `${SYMBOL_TAG}${symbol}`])
    const missed = this.store.missed(symbol, since, RESUME_ROWS)
    const sweeps = this.rowsToday((day) =>
      this.store.sweepsSince(day, symbol, since, RESUME_ROWS)
    )
    const walls = this.rowsToday((day) =>
      this.store.wallsSince(day, symbol, since, RESUME_ROWS)
    )
    const frames = openingFrames({
      status: { type: "status", status: this.status() },
      missed: missed.length ? this.tradesFrame(this.seq, missed) : null,
      sweeps: sweeps.map((sweep) => this.sweepFrame(sweep)),
      walls: walls.map((wall) => this.wallFrame(wall)),
      threshold: {
        type: "threshold",
        seq: this.seq,
        threshold: thresholdOf(this.whales, symbol, this.lastTradeAt),
      },
      quote: this.quoteFrame(symbol),
    })
    for (const frame of frames) server.send(JSON.stringify(frame))
    log("client-connected", { symbol, since, missed: missed.length })
    this.ownSession.setLiveprice(this.wallCoverageSymbols())
    this.broadcastStatus()
    this.scheduleLiveprice()
  }

  /** A `client` for the status and the alarm, but no `sym:` tag: `fanOut` and the wall coverage skip it. */
  private acceptMarket(server: WebSocket, since: number) {
    this.ctx.acceptWebSocket(server, ["client", MARKET_TAG])
    const sweeps = this.rowsToday((day) =>
      this.store.marketSweepsSince(day, since, SWEEP_PAGE)
    )
    const walls = this.rowsToday((day) =>
      this.store.marketWallsSince(day, since, SWEEP_PAGE)
    )
    // The status first: one that advances the day clears the page. Then oldest first,
    // so a socket dropped partway resumes from what arrived and misses nothing.
    const rows = [
      ...sweeps.map((sweep) => this.sweepFrame(sweep)),
      ...walls.map((wall) => this.wallFrame(wall)),
    ].sort((a, b) => a.seq - b.seq)
    const frames: ReadonlyArray<TradeFrame> = [
      { type: "status", status: this.status() },
      ...rows,
    ]
    for (const frame of frames) server.send(JSON.stringify(frame))
    log("market-connected", { since, sweeps: sweeps.length })
    this.broadcastStatus()
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (!this.ctx.getTags(ws).includes("ingest")) return
    const { auth } = ingestOf(ws)
    if (auth === "refused") return
    if (auth === "pending") {
      this.authenticate(ws, message)
      return
    }
    if (typeof message === "string") {
      this.ingestControl(ws, message)
      return
    }
    if (ingestOf(ws).id !== this.ctx.storage.kv.get<string>(ACTIVE_KEY)) return
    const bytes = new Uint8Array(message)
    if (bytes[0] === COALESCED) {
      this.ingestLivePrices(bytes)
      return
    }
    this.ingestFrame(decodeWrap(bytes))
  }

  /** One Stockbit frame from the active source, whichever that is. */
  private ingestFrame(frame: WrapFrame) {
    // The own session's frames arrive one by one, not coalesced.
    if (frame.channel === "liveprice") {
      this.guardLivePrice(() => this.ingestLivePrice(frame))
      return
    }
    if (frame.channel === "malformed") this.skipped++
    if (frame.channel !== "running_trade_batch") return
    this.skipped += frame.undecodable
    this.ingestBatch(frame.trades)
  }

  private ingestControl(ws: WebSocket, message: string) {
    const parsed = ingestMessage(message)
    if (parsed === null) return
    if (parsed.type === "credential" && typeof parsed.b64 === "string") {
      this.ownSession.offerCredential(parsed.b64)
      return
    }
    if (parsed.type !== "datafeed" || typeof parsed.open !== "boolean") return
    const ingest = ingestOf(ws)
    const install =
      typeof parsed.install === "string" ? parsed.install : ingest.install
    ws.serializeAttachment({ ...ingest, datafeed: parsed.open, install })
    log("ingest-datafeed", { id: ingest.id, open: parsed.open, install })
    this.reselect()
    this.broadcastStatus()
  }

  private ingestBatch(raws: ReadonlyArray<RawTrade>) {
    const receivedAt = new Date().toISOString() as IsoDateTime
    const decoded = toTrades(raws, receivedAt)
    this.skipped += decoded.failed
    const kept = keepCurrentDay(this.day, decoded.trades)
    if (kept.day === null) return
    if (kept.cleared) this.clearDay(kept.day)
    this.day = kept.day
    const fresh = dedupe(this.last, kept.trades)
    if (!fresh.length) return

    const seq = ++this.seq
    const bySymbol = groupBySymbol(fresh)
    this.commitBatch(bySymbol, seq, kept.day, receivedAt)
    this.trades += fresh.length
    this.lastTradeAt = receivedAt
    this.fanOut(bySymbol, seq)
    // After `fanOut`: a page takes a batch's `trades` frame first, whatever else it hears.
    this.sendWhales(
      feedTrades(this.whales, fresh, seq),
      closeIdle(this.whales, Date.parse(receivedAt), seq),
      feedWallTrades(
        this.walls,
        this.whales,
        fresh,
        new Set(this.wallCoverageSymbols()),
        seq
      ),
      expireWalls(this.walls, this.whales, Date.parse(receivedAt), seq)
    )
    // A status frame is what promotes a quiet symbol's page.
    this.pushStatusIfChanged()
    if (kept.cleared) this.sendSessionThresholds()
  }

  /** After the day-clearing status, which leaves a quiet symbol's page with no threshold. */
  private sendSessionThresholds() {
    for (const symbol of openSymbols(this.clientTags()))
      this.thresholdsDue.add(symbol)
    this.sendThresholds(Date.now())
  }

  /** No await in here, so the rows commit together. */
  private commitBatch(
    bySymbol: ReadonlyMap<Symbol, ReadonlyArray<Trade>>,
    seq: number,
    day: string,
    receivedAt: IsoDateTime
  ) {
    for (const [symbol, trades] of bySymbol) {
      const rg = lastRgTrade(trades)
      this.store.appendBatch(symbol, seq, day, receivedAt, trades, rg)
      if (rg)
        this.quotes.setRg(symbol, {
          price: rg.price,
          change: rg.change,
          receivedAt: rg.receivedAt,
        })
    }
  }

  private fanOut(
    bySymbol: ReadonlyMap<Symbol, ReadonlyArray<Trade>>,
    seq: number
  ) {
    for (const [symbol, trades] of bySymbol) {
      const sockets = this.open(`${SYMBOL_TAG}${symbol}`)
      if (!sockets.length) continue
      const out = JSON.stringify(this.tradesFrame(seq, trades))
      for (const s of sockets) s.send(out)
    }
  }

  private clearDay(day: string) {
    log("day-cleared", { from: this.day, to: day, trades: this.trades })
    this.endWhaleDay(day)
    this.store.clearDay(day)
    this.last.clear()
    this.quotes.clear()
    this.trades = 0
  }

  // ── quote ──────────────────────────────────────────────────────────────

  /** A failure here is counted and goes no further: `liveprice` must never touch the tape. */
  private ingestLivePrices(message: Uint8Array) {
    this.guardLivePrice(() => {
      const { frames, truncated } = unpackCoalesced(message)
      if (truncated) this.skipped++
      for (const frame of frames) this.ingestLivePrice(decodeWrap(frame))
    })
  }

  private guardLivePrice(ingest: () => void) {
    try {
      ingest()
    } catch (error) {
      this.skipped++
      log("liveprice-failed", { error: String(error) })
    }
  }

  private ingestLivePrice(frame: WrapFrame) {
    if (frame.channel !== "liveprice" || !isSymbol(frame.liveprice.stock)) {
      this.skipped++
      return
    }
    const symbol = frame.liveprice.stock
    // Before the fold, which drops a frame that leaves the figures as they are.
    this.feedLiveMatch(symbol, frame.liveprice)
    if (!this.quotes.fold(symbol, frame.liveprice, this.day, Date.now())) return
    const sockets = this.open(`${SYMBOL_TAG}${symbol}`)
    if (!sockets.length) return
    const quote = this.quoteFrame(symbol)
    if (quote === null) return
    const out = JSON.stringify(quote)
    for (const s of sockets) s.send(out)
  }

  private quoteFrame(symbol: Symbol): TradeFrame | null {
    const served = this.quotes.served(symbol, this.day)
    if (served === null) return null
    return {
      type: "quote",
      symbol,
      quote: served.quote,
      provenance: this.provenance("stockbit-liveprice", served.asOf),
    }
  }

  /** Coalesces every change of the wall coverage, and each `resume`, into one message. */
  private scheduleLiveprice() {
    this.livepriceTimer ??= setTimeout(() => {
      this.livepriceTimer = null
      this.activeSocket()?.send(
        JSON.stringify({
          type: "liveprice",
          symbols: this.wallCoverageSymbols(),
        } satisfies IngestControl)
      )
    }, LIVEPRICE_DEBOUNCE_MS)
  }

  override webSocketClose(ws: WebSocket, code: number) {
    const tags = this.ctx.getTags(ws)
    if (tags.includes("ingest")) {
      const { id, auth } = ingestOf(ws)
      log("ingest-closed", { id, code })
      if (auth !== "authenticated") return
      if (id === this.ctx.storage.kv.get<string>(ACTIVE_KEY))
        this.flushSketches()
      this.reselect()
    } else {
      log("client-closed", { tag: tags[1], code })
      this.scheduleLiveprice()
      this.ownSession.setLiveprice(this.wallCoverageSymbols())
    }
    this.broadcastStatus()
  }

  // ── whales ─────────────────────────────────────────────────────────────

  /** Stores each changed row and sends one frame per row, then any threshold now due. */
  private sendWhales(...batches: ReadonlyArray<Changes>) {
    for (const { sweeps, walls, thresholds } of batches) {
      for (const sweep of sweeps) {
        if (this.store.upsertSweep(sweep)) this.sweepCount++
        this.sendRow(sweep.symbol, () => this.sweepFrame(sweep))
      }
      for (const wall of walls) {
        if (this.store.upsertWall(wall)) this.wallCount++
        this.sendRow(wall.symbol, () => this.wallFrame(wall))
      }
      for (const symbol of thresholds) this.thresholdsDue.add(symbol)
    }
    this.sendThresholds(Date.now())
  }

  /** The frame is built only for a symbol someone hears. */
  private sendRow(symbol: Symbol, frame: () => TradeFrame) {
    const sockets = this.whaleSockets(symbol)
    if (!sockets.length) return
    const out = JSON.stringify(frame())
    for (const s of sockets) s.send(out)
  }

  /** A symbol held back by the 10 s stays due, so its last change still goes out. */
  private sendThresholds(now: number) {
    for (const symbol of this.thresholdsDue) {
      const sent = this.thresholdSent.get(symbol)
      if (sent && now - sent.at < THRESHOLD_FRAME_MS) continue
      this.thresholdsDue.delete(symbol)
      const sockets = this.whaleSockets(symbol)
      if (!sockets.length) continue
      const threshold = thresholdOf(this.whales, symbol, this.lastTradeAt)
      const said = JSON.stringify({ ...threshold, asOf: null })
      if (sent?.said === said) continue
      this.thresholdSent.set(symbol, { at: now, said })
      const out = JSON.stringify({
        type: "threshold",
        seq: this.seq,
        threshold,
      } satisfies TradeFrame)
      for (const s of sockets) s.send(out)
    }
  }

  private whaleSockets(symbol: Symbol): Array<WebSocket> {
    return [...this.open(`${SYMBOL_TAG}${symbol}`), ...this.open(MARKET_TAG)]
  }

  private sweepFrame(sweep: Sweep): Extract<TradeFrame, { type: "sweep" }> {
    return {
      type: "sweep",
      seq: sweep.seq,
      provenance: this.provenance("stockbit-running-trades", sweep.updatedAt),
      sweep,
      threshold: thresholdOf(this.whales, sweep.symbol, this.lastTradeAt),
    }
  }

  private wallFrame(wall: Wall): Extract<TradeFrame, { type: "wall" }> {
    return {
      type: "wall",
      seq: wall.seq,
      provenance: this.provenance("stockbit-liveprice", wall.lastSeen),
      wall,
      threshold: thresholdOf(this.whales, wall.symbol, this.lastTradeAt),
    }
  }

  /** A frame with no match, or of another day, counts as heard and as no hit. */
  private feedLiveMatch(symbol: Symbol, raw: RawLivePrice) {
    const now = Date.now()
    const quiet = now - this.lastCoveredLiveAt() >= LIVE_MS
    this.lastLiveAt.set(symbol, now)
    const hit = makerHit(
      symbol,
      raw,
      new Date(now).toISOString() as IsoDateTime
    )
    if (hit && matchDay(hit.matchNumber) === this.day)
      this.sendWhales(feedHit(this.walls, this.whales, hit, this.seq))
    // The status is what tells a page with no wall that the walls' feed came back.
    if (quiet) this.pushStatusIfChanged()
  }

  private reloadWalls() {
    if (this.day === null) return
    const walls = this.store.wallsToday(this.day)
    restoreWalls(this.walls, walls)
    this.wallCount = walls.length
  }

  /** Sketches and the replay point, in one event, so a rebuild reads no further back. */
  private flushSketches() {
    if (this.day === null) return
    this.ctx.storage.kv.put(
      WHALE_REPLAY_KEY,
      flushWhales(this.store, this.whales, this.day, this.seq)
    )
  }

  private flushWhenOwnSessionStops() {
    const { live } = this.ownSession
    if (this.ownSessionWasLive && !live) this.flushSketches()
    this.ownSessionWasLive = live
  }

  /** `this.day` is still the ended one, and null on the relay's first trade. */
  private endWhaleDay(next: string) {
    this.whales =
      this.day === null
        ? createWhales(this.store.priorSketches(next))
        : endWhaleSession(this.store, this.whales, this.day, next, this.seq)
    this.walls = createWalls()
    this.wallCount = 0
    this.sweepCount = 0
    this.thresholdSent.clear()
    this.thresholdsDue.clear()
  }

  // ── source ─────────────────────────────────────────────────────────────

  /** A stored id outlives its socket across a deploy; only an open socket counts. */
  private activeSocket(): WebSocket | null {
    const id = this.ctx.storage.kv.get<string>(ACTIVE_KEY)
    return this.ingests().find((s) => ingestOf(s).id === id) ?? null
  }

  /** Applies `selectSource`. Safe to call on any event: no change, no effect. */
  private reselect() {
    const ingests = this.ingests()
    const stored = this.ctx.storage.kv.get<string>(ACTIVE_KEY) ?? null
    const next = selectSource(
      stored,
      ingests.map(ingestOf),
      this.ownSession.live
    )
    if (next === stored) return
    if (next === null) this.ctx.storage.kv.delete(ACTIVE_KEY)
    else this.ctx.storage.kv.put(ACTIVE_KEY, next)
    const send = (id: string | null, type: "resume" | "pause") => {
      const socket = ingests.find((s) => ingestOf(s).id === id)
      socket?.send(JSON.stringify({ type } satisfies IngestControl))
    }
    send(stored, "pause")
    send(next, "resume")
    this.closeReplaced(ingests, stored, next)
    if (next !== null) this.scheduleLiveprice()
    const at = new Date().toISOString()
    this.store.addCoverage(
      tradingDay(at),
      at,
      next === null ? "none" : next === OWN_SESSION ? "upstream" : "extension"
    )
    log("source-switch", { from: stored, to: next })
  }

  /** The active ingest's socket, when its own install's reconnect took the role from it. */
  private closeReplaced(
    ingests: ReadonlyArray<WebSocket>,
    from: string | null,
    to: string | null
  ) {
    const socketOf = (id: string | null) =>
      ingests.find((s) => ingestOf(s).id === id)
    const old = socketOf(from)
    const replacement = socketOf(to)
    if (!old || !replacement) return
    const { install } = ingestOf(old)
    if (!install || ingestOf(replacement).install !== install) return
    log("ingest-replaced", { id: from, by: to })
    old.close(INGEST_CLOSE.replaced, "replaced")
  }

  private source(): TradeSource {
    if (this.ownSession.live) return "upstream"
    return this.activeSocket() ? "extension" : "none"
  }

  // ── frames and status ──────────────────────────────────────────────────

  /** getWebSockets still returns a socket inside its own close handler. */
  private open(tag: string): Array<WebSocket> {
    return this.ctx
      .getWebSockets(tag)
      .filter((s) => s.readyState === WebSocket.OPEN)
  }

  /** The ingests past their auth: the only ones heard, counted or sent to. */
  private ingests(): Array<WebSocket> {
    return this.open("ingest").filter(
      (s) => ingestOf(s).auth === "authenticated"
    )
  }

  private toIngests(message: IngestControl) {
    const out = JSON.stringify(message)
    for (const s of this.ingests()) s.send(out)
  }

  private clientTags(): Array<string> {
    return this.open("client").flatMap((s) => this.ctx.getTags(s))
  }

  /** The wall coverage: the symbols with an open client socket, then the watched ones, at most 50. */
  private wallCoverageSymbols(): Array<Symbol> {
    return wallCoverageFrom(this.clientTags(), this.wallSymbols)
  }

  private tradesFrame(seq: number, trades: ReadonlyArray<Trade>): TradeFrame {
    return {
      type: "trades",
      seq,
      provenance: this.provenance(
        "stockbit-running-trades",
        trades.at(-1)?.receivedAt ?? null,
        "live"
      ),
      trades,
    }
  }

  private provenance(
    feed: TapeProvenance["feed"],
    asOf: TapeProvenance["asOf"],
    freshness?: TapeProvenance["freshness"]
  ): TapeProvenance {
    const source = this.source()
    return {
      feed,
      source,
      asOf,
      freshness:
        freshness ??
        (feed === "stockbit-liveprice"
          ? this.liveFreshness(source).freshness
          : this.freshness(source).freshness),
    }
  }

  private freshness(source: TradeSource) {
    const now = Date.now()
    return relayFreshness(
      now,
      this.lastTradeAt,
      source,
      phaseAt(now, this.calendar)
    )
  }

  /** The same rules as the tape, over the last frame across the wall coverage. */
  private liveFreshness(source: TradeSource) {
    const now = Date.now()
    return relayFreshness(
      now,
      this.lastLiveIso(),
      source,
      phaseAt(now, this.calendar)
    )
  }

  /** Frames for other symbols still reach the quotes: the extension forwards its tab's own. */
  private lastCoveredLiveAt() {
    return Math.max(
      0,
      ...this.wallCoverageSymbols().map((s) => this.lastLiveAt.get(s) ?? 0)
    )
  }

  private lastLiveIso(): IsoDateTime | null {
    const newest = this.lastCoveredLiveAt()
    return newest === 0 ? null : (new Date(newest).toISOString() as IsoDateTime)
  }

  /** The part of the status worth waking a page for: not its counters, but the radar shows the threshold counts. */
  private pushKey({
    source,
    freshness,
    reason,
    calendarOutOfDate: outOfDate,
    day,
    wallCoverage,
    thresholds,
    coverage,
  }: RelayStatus) {
    const receiving = wallCoverage.some((c) => c.receiving)
    const covered = wallCoverage.map((c) => c.symbol).join(",")
    return [
      source,
      freshness,
      reason,
      outOfDate,
      day,
      receiving,
      covered,
      thresholds.symbols,
      thresholds.warmingUp,
      coverage.map((c) => `${c.at}>${c.source}`).join(","),
    ].join("|")
  }

  private pushStatusIfChanged() {
    const status = this.status()
    const key = this.pushKey(status)
    if (key !== this.pushed) this.broadcast(status, key)
  }

  private broadcastStatus() {
    const status = this.status()
    this.broadcast(status, this.pushKey(status))
  }

  private broadcast(status: RelayStatus, key: string) {
    if (key !== this.pushed) {
      this.pushed = key
      this.ctx.storage.kv.put(PUSHED_KEY, key)
    }
    const out = JSON.stringify({
      type: "status",
      status,
    } satisfies TradeFrame)
    // Ingests get it too: the extension's popup shows the relay's own view.
    for (const s of [...this.open("client"), ...this.ingests()]) s.send(out)
  }

  // ── alarm ──────────────────────────────────────────────────────────────

  /** A next-open alarm can be days away, so an existing one may be too late. */
  private async ensureAlarm(at = Date.now() + ALARM_MS) {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }

  private ownSessionWake(now: number) {
    return wakeAt(this.ownSession.machine, now, (at) =>
      nextOpen(at, this.calendar)
    )
  }

  /** Every 30 s while a socket is open; none otherwise, so the object can hibernate. */
  override async alarm() {
    const now = Date.now()
    const authDeadlines = this.closeUnauthenticated(now)
    for (const ws of this.ingests()) {
      const { id, connectedAt } = ingestOf(ws)
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)
      if (!ingestIsSilent(now, pinged?.getTime() ?? null, connectedAt)) continue
      log("ingest-silent", { id })
      ws.close(INGEST_CLOSE.noPing, "no ping")
    }
    this.ownSession.tick()
    this.reselect()
    // The silent feed's close: no batch is coming to run it.
    this.sendWhales(
      closeIdle(this.whales, now, this.seq),
      expireWalls(this.walls, this.whales, now, this.seq)
    )
    this.flushSketches()
    this.quotes.flush(now)
    this.runWatchdog(now)
    this.pushStatusIfChanged()
    const { source, freshness, reason, ingests, clients } = this.status()
    log("alarm", {
      source,
      freshness,
      reason,
      ingests,
      clients,
      skipped: this.skipped,
    })
    this.skipped = 0
    const wakes = [
      ingests + clients > 0 ? now + ALARM_MS : null,
      this.ownSessionWake(now),
      ...authDeadlines,
    ].filter((at) => at !== null)
    if (wakes.length) await this.ctx.storage.setAlarm(Math.min(...wakes))
  }

  /** Closes each socket on the ingest path past its auth deadline, and returns the deadlines still ahead. */
  private closeUnauthenticated(now: number): Array<number> {
    const ahead: Array<number> = []
    for (const ws of this.open("ingest")) {
      const { id, connectedAt, auth } = ingestOf(ws)
      if (auth !== "pending") continue
      const deadline = connectedAt + AUTH_MS
      if (now < deadline) {
        ahead.push(deadline)
        continue
      }
      log("ingest-no-auth", { id })
      refuse(ws, INGEST_CLOSE.noAuth, "no auth")
    }
    return ahead
  }

  private runWatchdog(now: number) {
    const stored = this.ctx.storage.kv.get<Watchdog>(WATCHDOG_KEY) ?? null
    const active = this.activeSocket()
    const { state, send } = watchdog(stored, {
      now,
      phase: phaseAt(now, this.calendar),
      lastTradeAt: this.lastTradeAt,
      active: active !== null,
    })
    if (state === null) {
      if (stored !== null) this.ctx.storage.kv.delete(WATCHDOG_KEY)
    } else if (state !== stored) this.ctx.storage.kv.put(WATCHDOG_KEY, state)
    if (send === null || active === null) return
    active.send(
      JSON.stringify({ type: "recover", step: send } satisfies IngestControl)
    )
    log("recovery-step", { id: ingestOf(active).id, step: send })
  }

  // ── RPC ────────────────────────────────────────────────────────────────

  status(): RelayStatus {
    const source = this.source()
    const now = Date.now()
    const ingests = this.ingests()
    return {
      source,
      ...this.freshness(source),
      upstreamEnabled: this.ownSession.enabled,
      upstreamState: this.ownSession.machine.state,
      credentialExpiresAt: this.ownSession.credentialExpiresAt,
      ingests: ingests.length,
      datafeed: ingests.some((s) => ingestOf(s).datafeed),
      clients: this.open("client").length,
      lastTradeAt: this.lastTradeAt,
      seq: this.seq,
      day: this.day,
      symbols: this.last.size,
      trades: this.trades,
      calendarOutOfDate: calendarOutOfDate(now, this.calendar),
      sweeps: this.sweepCount,
      walls: this.wallCount,
      wallCoverage: this.wallCoverageSymbols().map((symbol) => ({
        symbol,
        receiving: now - (this.lastLiveAt.get(symbol) ?? 0) < LIVE_MS,
      })),
      thresholds: thresholdCounts(this.whales),
      coverage: this.store.coverage(),
    }
  }

  /** Behind `POST /api/relay/upstream`. Off in every new namespace. */
  async setOwnSession(enabled: boolean): Promise<RelayStatus> {
    this.ownSession.setEnabled(enabled)
    const wake = this.ownSessionWake(Date.now())
    if (wake !== null) await this.ensureAlarm(wake)
    return this.status()
  }

  /** Replaces the watched list whole. Its sender, the alerts page, is gone; the list stays as last sent. */
  setWallSymbols(symbols: ReadonlyArray<Symbol>) {
    this.store.replaceWallSymbols(symbols)
    this.wallSymbols = this.store.wallSymbols()
    this.scheduleLiveprice()
    this.ownSession.setLiveprice(this.wallCoverageSymbols())
    this.pushStatusIfChanged()
  }

  /** Today's rows, or none before the relay's first trade. */
  private rowsToday<T>(read: (day: string) => Array<T>): Array<T> {
    return this.day === null ? [] : read(this.day)
  }

  /**
   * First paint only, and a stated difference from membership in the coverage: the page
   * opening is what covers it, so ask with its socket open. The first status corrects it.
   */
  private wouldCover(symbol: Symbol) {
    return wallCoverageFrom(
      [...this.clientTags(), `${SYMBOL_TAG}${symbol}`],
      this.wallSymbols
    ).includes(symbol)
  }

  backfill(symbol: Symbol): TapeBackfill {
    const trades = this.store.newest(symbol, TAPE_KEEP)
    const served = this.quotes.served(symbol, this.day)
    return {
      symbol,
      seq: this.seq,
      day: this.day,
      trades,
      offBoard: this.store.newestOffBoard(symbol, OFF_BOARD_KEEP),
      quote: served?.quote ?? NO_QUOTE,
      quoteAsOf: served?.asOf ?? null,
      coverage: this.store.coverage(),
      provenance: this.provenance(
        "stockbit-running-trades",
        trades[0]?.receivedAt ?? served?.asOf ?? null
      ),
      sweeps: this.rowsToday((day) => this.store.sweepsOf(day, symbol)),
      walls: this.rowsToday((day) => this.store.wallsOf(day, symbol)),
      threshold: thresholdOf(this.whales, symbol, this.lastTradeAt),
      wallCoverage: this.wouldCover(symbol),
      liveprice: this.provenance("stockbit-liveprice", this.lastLiveIso()),
    }
  }

  /** Both read at one `seq`, so the page's socket resumes where its candles end. */
  liveSymbol(symbol: Symbol): LiveSymbol {
    return {
      backfill: this.backfill(symbol),
      candles: foldCandles(NO_CANDLES, this.store.batches(symbol)),
    }
  }

  /** The radar's first paint. The leaderboard's totals cover every symbol with sweeps, and the rows the page leaves out. */
  today(): WhalesToday {
    const { day } = this
    const sweeps = day === null ? [] : this.store.newestSweeps(day, SWEEP_PAGE)
    return {
      seq: this.seq,
      day,
      sweeps,
      sweepsTotal: this.sweepCount,
      leaderboard: day === null ? [] : this.store.leaderboard(day),
      walls: day === null ? [] : this.store.wallsToday(day),
      wallCoverage: this.status().wallCoverage,
      thresholds: this.status().thresholds,
      provenance: this.provenance(
        "stockbit-running-trades",
        sweeps[0]?.updatedAt ?? this.lastTradeAt
      ),
      liveprice: this.provenance("stockbit-liveprice", this.lastLiveIso()),
    }
  }

  /** The radar's next page, once the operator scrolls past the end. */
  earlier(cursor: SweepCursor): Array<Sweep> {
    return this.store.sweepsEarlier(cursor, SWEEP_PAGE)
  }
}
