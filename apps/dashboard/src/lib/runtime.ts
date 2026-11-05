import { env } from "cloudflare:workers"
import { ConfigProvider, Layer, ManagedRuntime } from "effect"

import { Market } from "@/services/market"
import { Radar } from "@/services/radar"
import { Tape } from "@/services/tape"
import { Whales } from "@/services/whales"

// Bindings are process-global on Workers, so the ConfigProvider is built once, not
// per request.
const strings = Object.fromEntries(
  Object.entries(env).filter(
    (e): e is [string, string] => typeof e[1] === "string"
  )
)

/** Server only: imported by page queries (and service tests), never by components. */
export const AppLayer = Layer.mergeAll(Market.layer, Radar.layer).pipe(
  Layer.provideMerge(Tape.live(env.TRADE_RELAY)),
  Layer.provideMerge(Whales.live(env.TRADE_RELAY)),
  Layer.provideMerge(
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(strings))
  )
)
export const runtime = ManagedRuntime.make(AppLayer)
