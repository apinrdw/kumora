import { Schema } from "effect"

import { Freshness } from "./freshness"
import { Symbol } from "./symbol"
import { IsoDateTime } from "./time"

/* The relay is the only decoder and encoder. The browser uses `import type` only. */

export const TradeSide = Schema.Literals(["buy", "sell", "unspecified"])
export type TradeSide = typeof TradeSide.Type

/**
 * Where the relay is taking trades from right now.
 * `SOURCES` in apps/stockbit-relay-extension/src/protocol.ts is a copy, and names this.
 */
export const TradeSource = Schema.Literals(["upstream", "extension", "none"])
export type TradeSource = typeof TradeSource.Type

/** One executed match on the exchange for a symbol. */
export const Trade = Schema.Struct({
  symbol: Symbol,
  price: Schema.Number,
  /** Shares, not lots. */
  volume: Schema.Number,
  /** Rupiah. */
  value: Schema.Number,
  side: TradeSide,
  board: Schema.String,
  /** Rises within a symbol across a trading day. */
  tradeNumber: Schema.Number,
  tradedAt: IsoDateTime,
  /** When the relay decoded it. */
  receivedAt: IsoDateTime,
  /** Rupiah against the previous close; the relay's decoder reads absent on the wire as 0. */
  change: Schema.Number,
})
export type Trade = typeof Trade.Type

/** What makes two reports the same trade. `day` is the WIB date of `tradedAt`. */
export const TradeIdentity = Schema.Struct({
  day: Schema.String,
  symbol: Symbol,
  tradeNumber: Schema.Number,
})
export type TradeIdentity = typeof TradeIdentity.Type

export const TapeProvenance = Schema.Struct({
  feed: Schema.Literals(["stockbit-running-trades", "stockbit-liveprice"]),
  source: TradeSource,
  asOf: Schema.NullOr(IsoDateTime),
  freshness: Freshness,
})
export type TapeProvenance = typeof TapeProvenance.Type

export const StaleReason = Schema.Literals([
  "break",
  "closed",
  "no-trades",
  "no-source",
])
export type StaleReason = typeof StaleReason.Type

/** The state of the relay's own session. */
export const OwnSessionState = Schema.Literals([
  "disabled",
  "idle",
  "no-credential",
  "connecting",
  "live",
  "backoff",
])
export type OwnSessionState = typeof OwnSessionState.Type

/** A symbol whose walls the relay asks for; `receiving` means a frame in the last 60 s. */
export const WallCoverage = Schema.Struct({
  symbol: Symbol,
  receiving: Schema.Boolean,
})
export type WallCoverage = typeof WallCoverage.Type

/** One source change: when coverage was missing, `source` is `none`. */
export const TapeCoverage = Schema.Struct({
  at: IsoDateTime,
  source: TradeSource,
})
export type TapeCoverage = typeof TapeCoverage.Type

/** What the relay reports about itself. */
/** Symbols with a threshold, and how many of them are still warming up. */
const ThresholdCounts = Schema.Struct({
  symbols: Schema.Number,
  warmingUp: Schema.Number,
})

/** The popup keeps a copy of the fields it shows: `RelayStatus` in apps/stockbit-relay-extension/src/protocol.ts. */
export const RelayStatus = Schema.Struct({
  source: TradeSource,
  freshness: Freshness,
  reason: Schema.NullOr(StaleReason),
  upstreamEnabled: Schema.Boolean,
  upstreamState: OwnSessionState,
  credentialExpiresAt: Schema.NullOr(IsoDateTime),
  ingests: Schema.Number,
  /** Whether any ingest reports a datafeed. */
  datafeed: Schema.Boolean,
  clients: Schema.Number,
  lastTradeAt: Schema.NullOr(IsoDateTime),
  seq: Schema.Number,
  day: Schema.NullOr(Schema.String),
  symbols: Schema.Number,
  trades: Schema.Number,
  calendarOutOfDate: Schema.Boolean,
  /** Today's sweep rows. */
  sweeps: Schema.Number,
  /** Today's wall rows. */
  walls: Schema.Number,
  wallCoverage: Schema.Array(WallCoverage),
  thresholds: ThresholdCounts,
  /** The relay's record of its source, oldest first: a few rows, today's only after a day clear. */
  coverage: Schema.Array(TapeCoverage),
})
export type RelayStatus = typeof RelayStatus.Type

/** A Quote whose Provenance says live. A null figure renders as a dash. */
export const LiveQuote = Schema.Struct({
  last: Schema.NullOr(Schema.Number),
  prev: Schema.NullOr(Schema.Number),
  open: Schema.NullOr(Schema.Number),
  high: Schema.NullOr(Schema.Number),
  low: Schema.NullOr(Schema.Number),
  avg: Schema.NullOr(Schema.Number),
  volumeLot: Schema.NullOr(Schema.Number),
  /** Rupiah. */
  value: Schema.NullOr(Schema.Number),
  freq: Schema.NullOr(Schema.Number),
})
export type LiveQuote = typeof LiveQuote.Type

/** What a symbol's whale threshold rests on besides today's orders. */
export const ThresholdPrior = Schema.Literals(["own", "market", "none"])
export type ThresholdPrior = typeof ThresholdPrior.Type

/** A symbol's whale threshold right now, in lots, and how settled it is. */
export const ThresholdState = Schema.Struct({
  symbol: Symbol,
  /** Lots. Null with no prior and no orders, when nothing flags. */
  threshold: Schema.NullOr(Schema.Number),
  warmingUp: Schema.Boolean,
  prior: ThresholdPrior,
  /** Closed aggressor orders on the symbol this session. */
  ordersToday: Schema.Number,
  asOf: Schema.NullOr(IsoDateTime),
})
export type ThresholdState = typeof ThresholdState.Type

/** An aggressor order that reached the whale threshold, keyed (day, symbol, firstNumber). */
export const Sweep = Schema.Struct({
  day: Schema.String,
  symbol: Symbol,
  firstNumber: Schema.Number,
  lastNumber: Schema.Number,
  side: Schema.Literals(["buy", "sell"]),
  /** Always RG today: only the regular board's orders can be sweeps. */
  board: Schema.String,
  /** The order's instant, which every trade in it shares. */
  tradedAt: IsoDateTime,
  lots: Schema.Number,
  /** Rupiah. */
  value: Schema.Number,
  /** Trades in the order so far. */
  freq: Schema.Number,
  priceLow: Schema.Number,
  priceHigh: Schema.Number,
  /** The threshold it was judged against, in lots. */
  threshold: Schema.Number,
  warmingUp: Schema.Boolean,
  prior: ThresholdPrior,
  /** Still growing: nothing has closed the order yet. */
  open: Schema.Boolean,
  closedBy: Schema.NullOr(Schema.Literals(["next-order", "idle"])),
  announcedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** The current `seq` when the row last changed. */
  seq: Schema.Number,
})
export type Sweep = typeof Sweep.Type

/** A maker order whose matched lots reached the threshold, keyed (day, symbol, firstOrderNumber). */
export const Wall = Schema.Struct({
  day: Schema.String,
  symbol: Symbol,
  side: Schema.Literals(["bid", "offer"]),
  price: Schema.Number,
  /** Exceeds 2^53, so it stays a string. */
  firstOrderNumber: Schema.String,
  memberOrderNumbers: Schema.Array(Schema.String),
  /** Lower bounds, shown with "≥": `liveprice` keeps about one match in five. */
  hitsSeen: Schema.Number,
  lotsMatched: Schema.Number,
  threshold: Schema.Number,
  warmingUp: Schema.Boolean,
  prior: ThresholdPrior,
  firstSeen: IsoDateTime,
  lastSeen: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  closedBy: Schema.NullOr(Schema.Literals(["traded-through", "idle"])),
  /** The current `seq` when the row last changed. */
  seq: Schema.Number,
})
export type Wall = typeof Wall.Type

/** One symbol on the most-swept list. Rupiah. */
export const LeaderboardEntry = Schema.Struct({
  symbol: Symbol,
  buyValue: Schema.Number,
  sellValue: Schema.Number,
})
export type LeaderboardEntry = typeof LeaderboardEntry.Type

/** The tape the relay sends a dashboard session when it subscribes to a symbol. */
export const TapeBackfill = Schema.Struct({
  symbol: Symbol,
  /** The last batch included; a client resumes with `since=<seq>`. */
  seq: Schema.Number,
  /** The relay's trading day, which a symbol with no trades cannot show. */
  day: Schema.NullOr(Schema.String),
  /** Newest first, at most `TAPE_KEEP`. */
  trades: Schema.Array(Trade),
  /** The session's off-board trades, any board but RG: newest first, at most `OFF_BOARD_KEEP`. */
  offBoard: Schema.Array(Trade),
  quote: LiveQuote,
  /** The quote's own as-of. `provenance.asOf` follows the tape, which an NG trade moves too. */
  quoteAsOf: Schema.NullOr(IsoDateTime),
  coverage: Schema.Array(TapeCoverage),
  provenance: TapeProvenance,
  /** Today's, in full, newest first. */
  sweeps: Schema.Array(Sweep),
  /** Today's, in full, newest first. */
  walls: Schema.Array(Wall),
  threshold: ThresholdState,
  /** Whether the symbol is in the wall coverage, so its walls can be seen at all. */
  wallCoverage: Schema.Boolean,
  liveprice: TapeProvenance,
})
export type TapeBackfill = typeof TapeBackfill.Type

/** The whale radar's first paint. */
export const WhalesToday = Schema.Struct({
  seq: Schema.Number,
  day: Schema.NullOr(Schema.String),
  /** The newest 500. */
  sweeps: Schema.Array(Sweep),
  sweepsTotal: Schema.Number,
  /** Totals for every symbol with sweeps, biggest first. The browser shows the top 10. */
  leaderboard: Schema.Array(LeaderboardEntry),
  walls: Schema.Array(Wall),
  wallCoverage: Schema.Array(WallCoverage),
  thresholds: ThresholdCounts,
  provenance: TapeProvenance,
  liveprice: TapeProvenance,
})
export type WhalesToday = typeof WhalesToday.Type

/** A sweep's place in the market's newest-first order: where `Whales.earlier` carries on. */
export const SweepCursor = Schema.Struct({
  day: Schema.String,
  announcedAt: IsoDateTime,
  symbol: Symbol,
  firstNumber: Schema.Number,
})
export type SweepCursor = typeof SweepCursor.Type

/** One minute of a symbol's regular-board trades. `at` is the minute's start. */
export const MinuteCandle = Schema.Struct({
  at: IsoDateTime,
  open: Schema.Number,
  high: Schema.Number,
  low: Schema.Number,
  close: Schema.Number,
  lots: Schema.Number,
})
export type MinuteCandle = typeof MinuteCandle.Type

/** One price of a session's volume profile: its regular-board lots by the taker's side. */
export const ProfileLevel = Schema.Struct({
  price: Schema.Number,
  buy: Schema.Number,
  sell: Schema.Number,
  /** Lots whose side the feed left unspecified. */
  unspecified: Schema.Number,
})
export type ProfileLevel = typeof ProfileLevel.Type

/** A symbol's minute candles and volume profile so far, and the trade they run up to. */
export const CandleFold = Schema.Struct({
  lastNumber: Schema.Number,
  /** Oldest first. */
  candles: Schema.Array(MinuteCandle),
  /** The session so far, lowest price first. */
  profile: Schema.Array(ProfileLevel),
})
export type CandleFold = typeof CandleFold.Type

/** The whale radar live page's first paint for one symbol, read at one `seq`. */
export const LiveSymbol = Schema.Struct({
  backfill: TapeBackfill,
  candles: CandleFold,
})
export type LiveSymbol = typeof LiveSymbol.Type

/** A JSON text frame the relay sends a dashboard session. */
export const TradeFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("trades"),
    seq: Schema.Number,
    provenance: TapeProvenance,
    trades: Schema.Array(Trade),
  }),
  Schema.Struct({
    type: Schema.Literal("quote"),
    symbol: Symbol,
    quote: LiveQuote,
    provenance: TapeProvenance,
  }),
  Schema.Struct({ type: Schema.Literal("status"), status: RelayStatus }),
  Schema.Struct({
    type: Schema.Literal("sweep"),
    seq: Schema.Number,
    provenance: TapeProvenance,
    sweep: Sweep,
    threshold: ThresholdState,
  }),
  Schema.Struct({
    type: Schema.Literal("wall"),
    seq: Schema.Number,
    provenance: TapeProvenance,
    wall: Wall,
    threshold: ThresholdState,
  }),
  /** At most once per symbol per 10 s, and only when changed. */
  Schema.Struct({
    type: Schema.Literal("threshold"),
    seq: Schema.Number,
    threshold: ThresholdState,
  }),
])
export type TradeFrame = typeof TradeFrame.Type
