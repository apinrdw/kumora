// @vitest-environment happy-dom
import { StockCode, type BookEvent, type ViewerDown } from "@workspace/relay"
import { DateTime } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const toasts = vi.hoisted(() => ({ told: [] as Array<string> }))
vi.mock("@/components/k/toast", async () => {
  const { Effect } = await import("effect")
  const show = (title: string) =>
    Effect.sync(() => void toasts.told.push(title))
  return { kToast: { success: show, error: show, info: show } }
})
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
}))
vi.mock("@/components/market-live/use-special-board", () => ({
  useSpecialBoard: () => new Set(),
}))

// The browser's Web Locks, shared by every tab: one holder, a queue, and a
// steal that hands the lock over at once.
const makeLocks = () => {
  let holder: { readonly stolen: () => void } | undefined
  const waiting: Array<() => void> = []
  const next = () => waiting.shift()?.()
  const request = (
    _name: string,
    options: { readonly steal?: boolean; readonly signal?: AbortSignal },
    callback: () => Promise<unknown>
  ) =>
    new Promise((resolve, reject) => {
      const grant = () => {
        let settled = false
        const mine = {
          stolen: () => {
            settled = true
            reject(new DOMException("Lock stolen", "AbortError"))
          },
        }
        holder = mine
        void callback().then((value) => {
          if (settled) return
          settled = true
          holder = undefined
          resolve(value)
          next()
        })
      }
      if (options.steal === true) {
        holder?.stolen()
        return grant()
      }
      options.signal?.addEventListener("abort", () => {
        const index = waiting.indexOf(grant)
        if (index === -1) return
        waiting.splice(index, 1)
        reject(new DOMException("Aborted", "AbortError"))
      })
      if (holder === undefined) grant()
      else waiting.push(grant)
    })
  return { request }
}

const T0 = Date.parse("2026-11-18T02:10:00Z")

const eaten: BookEvent = {
  kind: "eaten",
  code: StockCode.make("BBCA"),
  at: DateTime.makeUnsafe(T0),
  side: "bid",
  price: 9_000,
  lots: 50_000,
  orders: 12,
  share: 0.9,
}

// A delta carrying `event`, half a second after it.
const deltaOf = (event: BookEvent): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(DateTime.toEpochMillis(event.at) + 500),
  tape: [],
  candles: [],
  bookEvents: [event],
})
const delta = deltaOf(eaten)

const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))

// A live page in a tab of its own: its own modules, so its own gate, over
// the browser's one localStorage and locks.
const openTab = async () => {
  vi.resetModules()
  const { useBookAlerts } =
    await import("@/components/book-alerts/use-book-alerts")
  const held: { apply?: (message: ViewerDown) => void } = {}
  function Page() {
    held.apply = useBookAlerts()
    return null
  }
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  act(() => root.render(<Page />))
  await settle()
  return {
    hear: (message: ViewerDown) => held.apply!(message),
    close: () => act(() => root.unmount()),
  }
}

// A browser with Web Locks and one rule: BBCA's eaten levels.
const browser = () => {
  Object.defineProperty(navigator, "locks", {
    value: makeLocks(),
    configurable: true,
  })
  window.localStorage.setItem(
    "kumora:book-alerts:rules",
    JSON.stringify([
      {
        id: "rule",
        kinds: ["eaten"],
        scope: { _tag: "codes", codes: ["BBCA"] },
        minValue: 0,
      },
    ])
  )
}

afterEach(() => {
  toasts.told = []
  window.localStorage.clear()
  document.body.innerHTML = ""
})

test("an event two tabs hear alerts once in the browser: one history entry, one toast", async () => {
  browser()
  const radar = await openTab()
  const marketLive = await openTab()
  act(() => {
    radar.hear(delta)
    marketLive.hear(delta)
  })
  await settle()
  const history = JSON.parse(
    window.localStorage.getItem("kumora:book-alerts:history") ?? "null"
  )
  expect(
    history?.alerts.length,
    "the shared history records the event once"
  ).toBe(1)
  expect(toasts.told, "one tab tells it").toHaveLength(1)
})

test("the page opened last tells, and the other takes over once it closes", async () => {
  browser()
  const radar = await openTab()
  const marketLive = await openTab()
  act(() => radar.hear(delta))
  await settle()
  expect(toasts.told, "the page that lost the lock tells nothing").toEqual([])
  marketLive.close()
  await settle()
  const later = deltaOf({ ...eaten, at: DateTime.makeUnsafe(T0 + 180_000) })
  act(() => radar.hear(later))
  await settle()
  expect(toasts.told, "the page left holds the lock").toHaveLength(1)
})
