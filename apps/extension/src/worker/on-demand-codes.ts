// The on-demand codes as the relay holds them (spec apinrdw/kumora#138, "the
// ingest envelope"): what each target's trading-day object asked for, and
// their union, which the Ajaib on-demand sockets keep subscribed.
import type { IngestDown, StockCode } from "@workspace/relay"
import { Effect } from "effect"

import type { TargetName } from "./settings.ts"

export const makeOnDemandCodes = Effect.fnUntraced(function* (options: {
  // Runs when the union changed or a target newly asked for codes, with the
  // codes it newly asked for: the Ajaib resubscribe follows it.
  readonly changed: (fresh: ReadonlyArray<StockCode>) => Effect.Effect<void>
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
      const before = new Set(byTarget.get(name) ?? [])
      const codes = message?.codes ?? []
      byTarget.set(name, codes)
      // A target's codes are diffed per target, not only as the
      // union. A code it newly asks for while the other target holds it, or
      // held before its socket dropped, is subscribed afresh so Ajaib resends
      // the whole book (see `onDemandMessages`): a book can't be backfilled.
      // See apinrdw/kumora#157.
      const fresh = codes.filter((code) => !before.has(code))
      const next = [...new Set([...byTarget.values()].flat())].sort()
      const same = JSON.stringify(next) === JSON.stringify(union)
      union = next
      return same && fresh.length === 0 ? Effect.void : options.changed(fresh)
    })

  return { receive, codes: Effect.sync(() => union) }
})
