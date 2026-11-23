import { clientRuntime } from "@workspace/client"
import type { OrderSize } from "@workspace/relay"
import { Effect, Schema } from "effect"
import { useCallback, useSyncExternalStore } from "react"

import { makeSchemaStoredValue } from "@/lib/stored-value"

// Decision: each browser keeps its own settings in localStorage
// (apps/dashboard/docs/adr/0021-each-browser-keeps-its-own-settings-in-localstorage.md)
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
