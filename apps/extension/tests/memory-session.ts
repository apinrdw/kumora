// chrome.storage's session and local areas in memory, their calls answered
// asynchronously as Chrome's are, so two fibers' calls interleave. `raw` is
// everything the session area stored, as JSON.
import { vi } from "@effect/vitest"
import { Effect } from "effect"

type Keys = string | ReadonlyArray<string> | null | undefined

const memoryArea = () => {
  const memory: Record<string, unknown> = {}
  const answer = <A>(value: () => A) =>
    Effect.runPromise(Effect.sync(() => structuredClone(value())))
  const pick = (keys: Keys) =>
    keys === null || keys === undefined
      ? memory
      : Object.fromEntries(
          (typeof keys === "string" ? [keys] : keys)
            .filter((key) => key in memory)
            .map((key) => [key, memory[key]])
        )
  return {
    memory,
    area: {
      get: (keys: Keys) => answer(() => pick(keys)),
      set: (items: Record<string, unknown>) =>
        answer(() => void Object.assign(memory, structuredClone(items))),
      remove: (keys: string | ReadonlyArray<string>) =>
        answer(() => {
          for (const key of typeof keys === "string" ? [keys] : keys)
            delete memory[key]
        }),
    },
  }
}

export const memorySession = () => {
  const session = memoryArea()
  const local = memoryArea()
  vi.stubGlobal("chrome", {
    storage: { session: session.area, local: local.area },
  })
  return { raw: () => JSON.stringify(session.memory) }
}
