import { clientRuntime } from "@workspace/client"
import { Effect, Schema } from "effect"

// Who watches a value kept in localStorage, as `useSyncExternalStore`
// subscribes: this page's write runs `changed`, and, when `crossTab`,
// another tab's write fires `storage`.
const makeStorageListeners = (crossTab: boolean) =>
  Effect.sync(() => {
    const listeners = new Set<() => void>()
    return {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        if (crossTab) window.addEventListener("storage", listener)
        return () => {
          listeners.delete(listener)
          if (crossTab) window.removeEventListener("storage", listener)
        }
      },
      changed: Effect.sync(() => {
        for (const listener of listeners) listener()
      }),
    }
  })

// A value as JSON text: the `serialize` of a stored value kept as JSON.
export const jsonText = (value: unknown) =>
  Effect.sync(() => JSON.stringify(value))

// One browser value kept in localStorage under `key`, for
// `useSyncExternalStore`. `parse` reads the stored text (null when nothing
// is stored), and `serialize` writes a value back (null removes the key).
// Storage blocked reads as nothing stored, and a value whose write failed
// lasts until a later write is stored, or as long as the page. `snapshot`
// keeps the value it last parsed while the stored text is unchanged, so
// React sees the same object. Another tab's write is seen too, unless
// `crossTab` is false: then the value is read once and changes only by this
// tab's writes.
export const makeStoredValue = <A>({
  key,
  parse,
  serialize,
  crossTab = true,
}: {
  key: string
  parse: (raw: string | null) => Effect.Effect<A>
  serialize: (value: A) => Effect.Effect<string | null>
  crossTab?: boolean
}) =>
  Effect.gen(function* () {
    const { subscribe, changed } = yield* makeStorageListeners(crossTab)
    const read = Effect.try(() => window.localStorage.getItem(key)).pipe(
      Effect.orElseSucceed(() => null)
    )
    let cached: { raw: string | null; value: A } | undefined
    let unstored: { value: A } | undefined

    const current = Effect.gen(function* () {
      if (unstored !== undefined) return unstored.value
      if (!crossTab && cached !== undefined) return cached.value
      const raw = yield* read
      if (cached === undefined || raw !== cached.raw)
        cached = { raw, value: yield* parse(raw) }
      return cached.value
    })

    const write = Effect.fnUntraced(function* (value: A) {
      const text = yield* serialize(value)
      unstored = yield* Effect.try(() =>
        text === null
          ? window.localStorage.removeItem(key)
          : window.localStorage.setItem(key, text)
      ).pipe(
        Effect.as(undefined),
        Effect.orElseSucceed(() => ({ value }))
      )
      if (!crossTab) cached = { raw: text, value }
      yield* changed
    })

    return {
      subscribe,
      snapshot: () => clientRuntime.runSync(current),
      current,
      write,
    }
  })

// A stored value kept as `schema`'s JSON: anything else stored, or nothing,
// reads as `fallback`.
export const makeSchemaStoredValue = <A>({
  key,
  schema,
  fallback,
  crossTab,
}: {
  key: string
  schema: Schema.Codec<A, unknown>
  fallback: A
  crossTab?: boolean
}) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema))
  return makeStoredValue({
    key,
    crossTab,
    parse: (raw) =>
      raw === null
        ? Effect.succeed(fallback)
        : decode(raw).pipe(Effect.orElseSucceed(() => fallback)),
    serialize: (value) => encode(value).pipe(Effect.orDie),
  })
}
