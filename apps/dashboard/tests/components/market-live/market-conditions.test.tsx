import type { MarketConditions, ViewerDown } from "@workspace/relay"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"
import { renderToString } from "react-dom/server"
import { expect, test } from "vitest"

import {
  MarketConditionsBar,
  applyConditions,
  conditionsReconnecting,
  resetConditions,
} from "@/components/market-live/market-conditions"

import { everySplit } from "../../interleaved"

const conditionsOf = (phase: MarketConditions["phase"]): MarketConditions => ({
  phase,
  relayOnline: true,
  feeds: { Stockbit: "live", Ajaib: "live" },
  gaps: [],
})

const snapshot: ViewerDown = {
  _tag: "Snapshot",
  selected: StockCode.make("BBCA"),
  tape: [],
  candles: [],
  conditions: conditionsOf("pre-opening"),
}

const delta: ViewerDown = {
  _tag: "Delta",
  tape: [],
  candles: [],
  conditions: conditionsOf("session-1"),
}

// The page as the socket's snapshot left it, before the drop.
const connected = Effect.andThen(resetConditions, applyConditions(snapshot))

// The bar as the page renders it, read straight from the store.
const bar = () => renderToString(<MarketConditionsBar />)

// After a delta and the socket's drop, in either order, the bar shows the
// delta's phase and that the socket reconnects.
const showsBoth = (at: number) =>
  Effect.sync(() => {
    const html = bar()
    expect(html, `split at operation ${at}`).toContain("Session 1")
    expect(html, `split at operation ${at}`).toContain("Reconnecting")
  })

// The socket's consumer applies a queued delta on one fiber while the
// socket's own fiber reports the drop that ends the connection
// (live-tape.tsx), so either can be suspended at any operation while the
// other runs whole. everySplit returns how many operations `first` took, so
// the split loop ran.
test("a delta suspended as the socket drops keeps its phase and the reconnect", () =>
  Effect.runPromise(
    everySplit({
      setup: connected,
      first: () => applyConditions(delta),
      second: () => conditionsReconnecting,
      check: (_, at) => showsBoth(at),
    })
  ).then((ops) => expect(ops).toBeGreaterThan(0)))

test("the drop suspended as a delta applies keeps the delta's phase and the reconnect", () =>
  Effect.runPromise(
    everySplit({
      setup: connected,
      first: () => conditionsReconnecting,
      second: () => applyConditions(delta),
      check: (_, at) => showsBoth(at),
    })
  ).then((ops) => expect(ops).toBeGreaterThan(0)))
