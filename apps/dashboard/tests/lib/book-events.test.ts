import { assert, describe, it } from "@effect/vitest"
import { StockCode, type BookEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { BOOK_EVENT_NAMES, bookEventDetail } from "@/lib/book-events"

const base = {
  code: StockCode.make("FOLK"),
  at: DateTime.makeUnsafe("2026-11-17T02:15:59.045Z"),
  side: "bid" as const,
}

// The spec's detail lines (apinrdw/kumora#517, "Book events").
const LINES: ReadonlyArray<readonly [BookEvent, string, string]> = [
  [
    {
      ...base,
      kind: "absorbed",
      price: 7600,
      lots: 11_400,
      orders: 9,
      shown: 4_200,
    },
    "Absorbed",
    "11.4 K lots traded into 7,600, 4.2 K still shown",
  ],
  [
    {
      ...base,
      kind: "eaten",
      price: 7600,
      lots: 9_000,
      orders: 30,
      share: 0.951,
    },
    "Eaten",
    "7,600 gone, trades explain 95%",
  ],
  [
    {
      ...base,
      kind: "reloaded",
      price: 7550,
      lots: 1_900,
      orders: 7,
      shown: 2_000,
      refills: 4,
      crowd: true,
    },
    "Reloaded",
    "7,550 refilled 4× · crowd",
  ],
  [
    {
      ...base,
      kind: "reloaded",
      price: 7550,
      lots: 1_900,
      orders: 1,
      shown: 2_000,
      refills: 1,
      crowd: false,
    },
    "Reloaded",
    "7,550 refilled 1× · single",
  ],
  [
    {
      ...base,
      kind: "appeared",
      price: 7700,
      lots: 28_300,
      orders: 3,
      ticks: 3,
    },
    "Wall appeared",
    "28.3 K lots at 7,700 · 3 orders · 3 ticks away",
  ],
  [
    {
      ...base,
      kind: "pulled",
      price: 5000,
      lots: 11_900,
      orders: 1,
      ticks: 2,
      approached: true,
    },
    "Pulled",
    "11.9 K lots at 5,000 · 1 order · 2 ticks, as price approached",
  ],
  [
    {
      ...base,
      kind: "pulled",
      price: 5000,
      lots: 11_900,
      orders: 5,
      ticks: 8,
      approached: false,
    },
    "Pulled",
    "11.9 K lots at 5,000 · 5 orders · 8 ticks",
  ],
  [
    {
      ...base,
      kind: "moved",
      price: 7750,
      lots: 38_200,
      orders: 3,
      wallLots: 40_000,
      to: 7700,
    },
    "Wall moved",
    "38.2 K lots 7,750 → 7,700",
  ],
]

describe("book event copy", () => {
  it.effect("names each kind and writes its detail line", () =>
    Effect.gen(function* () {
      for (const [event, name, line] of LINES) {
        assert.strictEqual(BOOK_EVENT_NAMES[event.kind], name)
        assert.strictEqual(yield* bookEventDetail(event), line)
      }
    })
  )
})
