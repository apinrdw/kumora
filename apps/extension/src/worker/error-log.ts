// The worker's Error and Fatal log lines, kept for the options page's
// diagnostics (apinrdw/kumora#274). The console still gets every line.
import { Cause, Effect, Formatter, Logger, Schema } from "effect"

export const ErrorLogEntry = Schema.Struct({
  at: Schema.Finite,
  level: Schema.Literals(["Error", "Fatal"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.String),
})
export type ErrorLogEntry = typeof ErrorLogEntry.Type

export interface ErrorLogStore {
  readonly load: Effect.Effect<ReadonlyArray<ErrorLogEntry>>
  readonly save: (entries: ReadonlyArray<ErrorLogEntry>) => Effect.Effect<void>
  // Every credential value the worker holds as it saves.
  readonly secrets: Effect.Effect<ReadonlyArray<string>>
}

// Decision: a cause is redacted as text right before it is stored, not by
// carrying credentials as `Redacted`: the text hides a value however it got
// there, a message built from an unwrapped one included. It hides each value
// the worker holds at save time, and any JWT, which covers Stockbit's token
// read from its cookie and never stored. See apinrdw/kumora#288.
const JWT = /eyJ[\w-]*\.[\w-]+\.[\w-]*/g

export const redact = (text: string, secrets: ReadonlyArray<string>) =>
  secrets
    .filter((secret) => secret !== "")
    .sort((a, b) => b.length - a.length)
    .reduce((hidden, secret) => hidden.replaceAll(secret, "<redacted>"), text)
    .replace(JWT, "<redacted>")

const KEPT = 50

// A log line as an entry, or undefined below Error.
const entryOf = Logger.make(
  ({ logLevel, message, cause, date }): ErrorLogEntry | undefined => {
    if (logLevel !== "Error" && logLevel !== "Fatal") return undefined
    const text = (Array.isArray(message) ? message : [message])
      .map((part) => (typeof part === "string" ? part : Formatter.format(part)))
      .join(" ")
    return {
      at: date.getTime(),
      level: logLevel,
      message: text,
      ...(cause.reasons.length > 0 && { cause: Cause.pretty(cause) }),
    }
  }
)

// Starts from the stored ring, so a restarted worker keeps its earlier
// lines, and saves the newest KEPT after each second with a new line, and
// when its scope closes.
export const makeErrorLog = Effect.fnUntraced(function* (store: ErrorLogStore) {
  let ring = yield* store.load
  return yield* Logger.batched(entryOf, {
    window: "1 second",
    flush: (batch) =>
      Effect.gen(function* () {
        const fresh = batch.filter((entry) => entry !== undefined)
        if (fresh.length === 0) return
        const secrets = yield* store.secrets
        const hidden = fresh.map(({ cause, ...entry }) => ({
          ...entry,
          message: redact(entry.message, secrets),
          ...(cause !== undefined && { cause: redact(cause, secrets) }),
        }))
        ring = [...ring, ...hidden].slice(-KEPT)
        yield* store.save(ring)
      }),
  })
})
