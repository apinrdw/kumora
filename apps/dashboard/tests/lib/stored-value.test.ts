// @vitest-environment happy-dom
import { Effect, Schema } from "effect"
import { afterEach, expect, test, vi } from "vitest"

import { makeSchemaStoredValue, makeStoredValue } from "@/lib/stored-value"

const KEY = "kumora:test:stored-value"

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

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

test("a value whose write failed lasts until a later write is stored", () => {
  const stored = count()
  // One write fails, as a full localStorage's does.
  vi.spyOn(window, "localStorage", "get").mockReturnValueOnce(
    undefined as unknown as Storage
  )
  Effect.runSync(stored.write(7))
  expect(window.localStorage.getItem(KEY)).toBeNull()
  expect(stored.snapshot()).toBe(7)

  Effect.runSync(stored.write(0))
  expect(stored.snapshot()).toBe(0)
  Effect.runSync(stored.write(3))
  expect(window.localStorage.getItem(KEY)).toBe("3")
  expect(stored.snapshot()).toBe(3)
})

test("a schema's value reads back, and anything else stored reads as its fallback", () => {
  const sizes = Effect.runSync(
    makeSchemaStoredValue({
      key: KEY,
      schema: Schema.Struct({ lots: Schema.Int }),
      fallback: { lots: 100 },
    })
  )
  expect(sizes.snapshot()).toEqual({ lots: 100 })
  Effect.runSync(sizes.write({ lots: 250 }))
  expect(window.localStorage.getItem(KEY)).toBe('{"lots":250}')
  expect(sizes.snapshot()).toEqual({ lots: 250 })
  window.localStorage.setItem(KEY, '{"lots":"many"}')
  expect(sizes.snapshot()).toEqual({ lots: 100 })
  window.localStorage.setItem(KEY, "not json")
  expect(sizes.snapshot()).toEqual({ lots: 100 })
})

test("another tab's write tells subscribers unless the value is this tab's own", () => {
  const shared = count()
  const own = Effect.runSync(
    makeStoredValue({
      key: KEY,
      parse: (raw) => Effect.succeed(Number(raw ?? 0)),
      serialize: (value: number) => Effect.succeed(String(value)),
      crossTab: false,
    })
  )
  let told = { shared: 0, own: 0 }
  shared.subscribe(() => (told = { ...told, shared: told.shared + 1 }))
  own.subscribe(() => (told = { ...told, own: told.own + 1 }))
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }))
  expect(told).toEqual({ shared: 1, own: 0 })
  // This tab's write tells its own subscribers either way.
  Effect.runSync(own.write(4))
  expect(told.own).toBe(1)
})
