import { Effect, Option } from "effect"

import {
  stallRecordLine,
  type StallRecord,
} from "../worker/broker-codes/stall-records.ts"
import type { ErrorLogEntry } from "../worker/error-log.ts"
import type { RelayStopped } from "../worker/settings.ts"

// The plain text Copy diagnostics puts on the clipboard: the version, the
// stopped relay's cause, the kept error lines, the broker codes keys and the
// kept stall records, oldest first.
export const diagnosticsText = Effect.fnUntraced(function* (parts: {
  readonly version: string
  readonly stopped: Option.Option<RelayStopped>
  readonly errors: ReadonlyArray<ErrorLogEntry>
  readonly keys: ReadonlyArray<readonly [string, unknown]>
  readonly stalls: ReadonlyArray<StallRecord>
}) {
  const stopped = Option.match(parts.stopped, {
    onNone: () => ["Relay stopped: no"],
    onSome: ({ at, cause }) => [
      `Relay stopped: ${new Date(at).toISOString()}`,
      cause,
    ],
  })
  const errors = parts.errors.flatMap(({ at, level, message, cause }) => [
    `${new Date(at).toISOString()} ${level} ${message}`,
    ...(cause === undefined ? [] : [cause]),
  ])
  const stalls: Array<string> = []
  for (const record of parts.stalls) stalls.push(yield* stallRecordLine(record))
  return [
    `Kumora relay ${parts.version}`,
    ...stopped,
    "",
    `Errors (${parts.errors.length}):`,
    ...errors,
    "",
    "Broker codes keys:",
    ...parts.keys.map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "",
    `Stall records (${parts.stalls.length}):`,
    ...stalls,
  ].join("\n")
})
