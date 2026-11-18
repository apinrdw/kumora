import { clientRuntime } from "@workspace/client"
import type { OrderSize } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"
import { useCallback, useSyncExternalStore } from "react"

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

const parse = Schema.decodeUnknownOption(Schema.fromJsonString(OrderSizes))

// Storage blocked reads as nothing stored: the defaults.
const read = Effect.try(() => window.localStorage.getItem(KEY)).pipe(
  Effect.orElseSucceed(() => null)
)

// The sizes as last read, kept while the stored text is unchanged, so React
// sees the same object.
let cached: { raw: string | null; sizes: OrderSizes } = {
  raw: null,
  sizes: DEFAULT,
}
// Sizes changed while storage is blocked: they last as long as the page.
let unstored: OrderSizes | undefined
const snapshot = () => {
  if (unstored !== undefined) return unstored
  const raw = clientRuntime.runSync(read)
  if (raw !== cached.raw)
    cached = {
      raw,
      sizes:
        raw === null ? DEFAULT : Option.getOrElse(parse(raw), () => DEFAULT),
    }
  return cached.sizes
}

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  // Another tab's change.
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

const write = Effect.fnUntraced(function* (sizes: OrderSizes) {
  yield* Effect.try(() =>
    window.localStorage.setItem(KEY, JSON.stringify(sizes))
  ).pipe(
    Effect.orElseSucceed(() => {
      unstored = sizes
    })
  )
  for (const listener of listeners) listener()
})

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
