import { clientRuntime } from "@workspace/client"
import { Effect } from "effect"

// Who watches a value kept in localStorage, as `useSyncExternalStore`
// subscribes: this page's write runs `changed`, and another tab's write fires
// `storage`.
const makeStorageListeners = Effect.sync(() => {
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      window.addEventListener("storage", listener)
      return () => {
        listeners.delete(listener)
        window.removeEventListener("storage", listener)
      }
    },
    changed: Effect.sync(() => {
      for (const listener of listeners) listener()
    }),
  }
})

// One browser value kept in localStorage under `key`, for
// `useSyncExternalStore`. `parse` reads the stored text (null when nothing
// is stored), and `serialize` writes a value back (null removes the key).
// Storage blocked reads as nothing stored, and a value written meanwhile
// lasts as long as the page. `snapshot` keeps the value it last parsed while
// the stored text is unchanged, so React sees the same object.
export const makeStoredValue = <A>({
  key,
  parse,
  serialize,
}: {
  key: string
  parse: (raw: string | null) => Effect.Effect<A>
  serialize: (value: A) => string | null
}) =>
  Effect.gen(function* () {
    const { subscribe, changed } = yield* makeStorageListeners
    const read = Effect.try(() => window.localStorage.getItem(key)).pipe(
      Effect.orElseSucceed(() => null)
    )
    let cached: { raw: string | null; value: A } | undefined
    let unstored: { value: A } | undefined

    const current = Effect.gen(function* () {
      if (unstored !== undefined) return unstored.value
      const raw = yield* read
      if (cached === undefined || raw !== cached.raw)
        cached = { raw, value: yield* parse(raw) }
      return cached.value
    })

    const write = Effect.fnUntraced(function* (value: A) {
      const text = serialize(value)
      yield* Effect.try(() =>
        text === null
          ? window.localStorage.removeItem(key)
          : window.localStorage.setItem(key, text)
      ).pipe(
        Effect.orElseSucceed(() => {
          unstored = { value }
        })
      )
      yield* changed
    })

    return {
      subscribe,
      snapshot: () => clientRuntime.runSync(current),
      current,
      write,
    }
  })
