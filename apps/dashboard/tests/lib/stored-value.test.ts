// @vitest-environment happy-dom
import { Effect } from "effect"
import { afterEach, expect, test } from "vitest"

import { makeStoredValue } from "@/lib/stored-value"

const KEY = "kumora:test:stored-value"

afterEach(() => window.localStorage.clear())

// A count kept under KEY, nothing stored while it is 0.
const count = () =>
  Effect.runSync(
    makeStoredValue({
      key: KEY,
      parse: (raw) => Effect.succeed(Number(raw ?? 0)),
      serialize: (value: number) =>
        Effect.succeed(value === 0 ? null : String(value)),
    })
  )

test("a written value is stored as `serialize` gives it, and read back", () => {
  const stored = count()
  Effect.runSync(stored.write(7))
  expect(window.localStorage.getItem(KEY)).toBe("7")
  expect(stored.snapshot()).toBe(7)
})

test("a value `serialize` gives no text for removes the key", () => {
  const stored = count()
  Effect.runSync(stored.write(7))
  Effect.runSync(stored.write(0))
  expect(window.localStorage.getItem(KEY)).toBeNull()
  expect(stored.snapshot()).toBe(0)
})
