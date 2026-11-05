import { createServerFn } from "@tanstack/react-start"
import { Config, Effect, Redacted, Schema } from "effect"

import { Symbol } from "@/domain/symbol"
import { SweepCursor } from "@/domain/trade"
import { runtime } from "@/lib/runtime"
import { MARKET } from "@/relay/routes"
import type { TicketSubject } from "@/relay/routes"
import { mintTicket } from "@/relay/ticket"
import { Radar } from "@/services/radar"
import { Tape } from "@/services/tape"
import { Whales } from "@/services/whales"

const radarPage = Effect.fn("radarQuery")(function* () {
  const radar = yield* Radar
  return yield* radar.candidates
})

/** The radar page query: the only caller of the runtime for `/radar`. */
export const radarQuery = createServerFn().handler(() =>
  runtime.runPromise(radarPage())
)

const earlierPage = Effect.fn("earlierSweeps")(function* (cursor: SweepCursor) {
  const whales = yield* Whales
  return yield* whales.earlier(cursor)
})

/** The next page of the sweep feed. */
export const earlierSweeps = createServerFn()
  .validator(Schema.toStandardSchemaV1(SweepCursor))
  .handler(({ data }) => runtime.runPromise(earlierPage(data)))

const todayPage = Effect.fn("whalesToday")(function* () {
  const whales = yield* Whales
  return yield* whales.today
})

/** Today again, for a page that came back from a gap a resume could not fill. */
export const whalesToday = createServerFn().handler(() =>
  runtime.runPromise(todayPage())
)

const liveRadarPage = Effect.fn("liveRadarQuery")(function* (
  wanted: Symbol | null
) {
  const whales = yield* Whales
  const tape = yield* Tape
  const today = yield* whales.today
  const symbol = wanted ?? today.leaderboard[0]?.symbol ?? null
  return {
    today,
    symbol,
    live: symbol === null ? null : yield* tape.liveSymbol(symbol),
  }
})

/** Wrapped in a Struct: TanStack's `Expand` mangles a bare branded string. */
const LiveRadarInput = Schema.Struct({ symbol: Schema.NullOr(Symbol) })

/** The live page's query: the market's day, and the symbol it asked for or the biggest one. */
export const liveRadarQuery = createServerFn()
  .validator(Schema.toStandardSchemaV1(LiveRadarInput))
  .handler(({ data }) => runtime.runPromise(liveRadarPage(data.symbol)))

const LiveSymbolInput = Schema.Struct({ symbol: Symbol })

const liveSymbolPage = Effect.fn("liveSymbolQuery")(function* (symbol: Symbol) {
  const tape = yield* Tape
  return yield* tape.liveSymbol(symbol)
})

/** One symbol again, for a page back from a reconnect. */
export const liveSymbolQuery = createServerFn()
  .validator(Schema.toStandardSchemaV1(LiveSymbolInput))
  .handler(({ data }) => runtime.runPromise(liveSymbolPage(data.symbol)))

const RelayTicketInput = Schema.Struct({
  symbol: Schema.Union([Symbol, Schema.Literal(MARKET)]),
})

const mintRelayTicket = Effect.fn("relayTicket")(function* (
  symbol: TicketSubject
) {
  const secret = yield* Config.Redacted("RELAY_TICKET_SECRET")
  return yield* Effect.promise(() =>
    mintTicket(Redacted.value(secret), symbol, Date.now())
  )
})

/** The 60-second ticket a page's socket presents to /ws/trades. */
export const relayTicket = createServerFn()
  .validator(Schema.toStandardSchemaV1(RelayTicketInput))
  .handler(({ data }) => runtime.runPromise(mintRelayTicket(data.symbol)))
