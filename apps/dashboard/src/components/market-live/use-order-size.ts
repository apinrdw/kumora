import { clientRuntime } from "@workspace/client"
import type { OrderSize } from "@workspace/relay"
import { Effect, Schema } from "effect"
import { useCallback, useSyncExternalStore } from "react"

import { makeSchemaStoredValue } from "@/lib/stored-value"

// Decision: like the watchlist (use-watchlist.ts), each browser keeps its
// own fill estimate order size in localStorage, one amount per unit, so the
// Rupiah / Lots toggle goes back to the last amount in each. See spec
// apinrdw/kumora#517, "Book readings".
const KEY = "kumora:market-live:order-size"

const OrderSizes = Schema.Struct({
  unit: Schema.Literals(["rupiah", "lots"]),
  rupiah: Schema.Finite.check(Schema.isGreaterThan(0)),
  lots: Schema.Int.check(Schema.isGreaterThan(0)),
})
type OrderSizes = typeof OrderSizes.Type

// The prototype's sizes: Rp10 billion, or 20,000 lots.
const DEFAULT: OrderSizes = { unit: "rupiah", rupiah: 10e9, lots: 20_000 }

// Storage blocked, or anything else stored, reads as the defaults.
const { subscribe, snapshot, write } = Effect.runSync(
  makeSchemaStoredValue({ key: KEY, schema: OrderSizes, fallback: DEFAULT })
)

// This browser's order size, and changes to its unit or to the amount in
// the current unit. The server render has the default.
export function useOrderSize() {
  const sizes = useSyncExternalStore(subscribe, snapshot, () => DEFAULT)
  const size: OrderSize = { unit: sizes.unit, amount: sizes[sizes.unit] }
  const pickUnit = useCallback(
    (unit: OrderSize["unit"]) =>
      clientRuntime.runSync(write({ ...snapshot(), unit })),
    []
  )
  const changeAmount = useCallback((amount: number) => {
    const current = snapshot()
    const next: OrderSizes =
      current.unit === "rupiah"
        ? { ...current, rupiah: amount }
        : { ...current, lots: amount }
    clientRuntime.runSync(write(next))
  }, [])
  return { size, pickUnit, changeAmount }
}
