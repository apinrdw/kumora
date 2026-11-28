// The Holder map's keys, one definition for the read and the view model: a
// holding's place, and a graph node's id.
import type { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import type { HolderKey } from "@/domain/holdings"

// A holding's place: its stock and holder key. Unique, since a code holds
// no space.
export const placeOf = (code: StockCode, holder: HolderKey) =>
  Effect.succeed(`${code} ${holder}`)

export type NodeKind = "stock" | "holder" | "custodian"

// A graph node's id: `stock:<code>`, `holder:<holder key>` or
// `custodian:<id>`, unique in the graph and stable across reloads.
export const nodeId = (kind: NodeKind, key: string) =>
  Effect.succeed(`${kind}:${key}`)
