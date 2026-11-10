// The on-demand codes as the relay holds them (spec apinrdw/kumora#138, "the
// ingest envelope"): what each target's trading-day object asked for, and
// their union, which the Ajaib on-demand sockets keep subscribed.
import type { IngestDown, StockCode } from "@workspace/relay"
import { Effect } from "effect"

import type { TargetName } from "./settings.ts"

export const makeOnDemandCodes = Effect.fnUntraced(function* (options: {
  // Runs when the union changed: the Ajaib resubscribe follows it.
  readonly changed: Effect.Effect<void>
  // A target's backfill request, passed on.
  readonly backfill: (
    name: TargetName,
    message: Extract<IngestDown, { _tag: "Backfill" }>
  ) => Effect.Effect<void>
}) {
  const byTarget = new Map<TargetName, ReadonlyArray<StockCode>>()
  let union: ReadonlyArray<StockCode> = []

  // What a target's socket sent down, or `undefined` once it isn't connected:
  // a target that isn't connected wants no codes.
  const receive = (name: TargetName, message: IngestDown | undefined) =>
    Effect.suspend(() => {
      if (message?._tag === "Backfill") return options.backfill(name, message)
      byTarget.set(name, message?.codes ?? [])
      const next = [...new Set([...byTarget.values()].flat())].sort()
      if (JSON.stringify(next) === JSON.stringify(union)) return Effect.void
      union = next
      return options.changed
    })

  return { receive, codes: Effect.sync(() => union) }
})
