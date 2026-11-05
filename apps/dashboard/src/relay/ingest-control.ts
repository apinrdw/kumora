import type { Symbol } from "@/domain/symbol"

import type { RecoveryStep } from "./watchdog"

/**
 * The relay's text messages to an ingest, other than `status`. `RelayMessage` in
 * apps/stockbit-relay-extension/src/protocol.ts is the reader's copy, and names this.
 */
export type IngestControl =
  | { readonly type: "resume" }
  | { readonly type: "pause" }
  | { readonly type: "liveprice"; readonly symbols: ReadonlyArray<Symbol> }
  | { readonly type: "recover"; readonly step: RecoveryStep }
  | { readonly type: "credential-needed" }
  | { readonly type: "credential-ok" }
  | { readonly type: "credential-stop" }

/**
 * An ingest's text messages to the relay, other than `ping`. `IngestMessage` in
 * apps/stockbit-relay-extension/src/protocol.ts is the writer's copy, and names this.
 * scripts/replay-stockbit-frames.mts and scripts/drive-extension.mts write `auth`
 * and `datafeed` too; the replay's `datafeed` has no install. `auth` is the first
 * message, and only the first: the secret stays out of the upgrade's headers, which
 * are logged.
 */
export type IngestMessage =
  | { readonly type: "auth"; readonly secret: string }
  | {
      readonly type: "datafeed"
      readonly open: boolean
      /** The extension install's id: when its old ingest is the active ingest, its reconnect takes over once it reports a datafeed. */
      readonly install?: string
    }
  | { readonly type: "credential"; readonly b64: string }
