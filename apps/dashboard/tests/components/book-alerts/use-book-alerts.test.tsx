// @vitest-environment happy-dom
import {
  StockCode,
  type BookEvent,
  type BookReadings,
  type ViewerDown,
} from "@workspace/relay"
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

// The browser's Web Locks, shared by every tab: per name, one holder, a
// queue, and a steal that hands the lock over. As in a browser, a request
// is granted on a later task, so a page can unmount before its grant.
const makeLocks = () => {
  const named = new Map<
    string,
    {
      holder: { readonly stolen: () => void } | undefined
      readonly waiting: Array<() => void>
    }
  >()
  const lockOf = (name: string) => {
    const held = named.get(name) ?? { holder: undefined, waiting: [] }
    named.set(name, held)
    return held
  }
  type Options = { readonly steal?: boolean; readonly signal?: AbortSignal }
  const request = (
    name: string,
    optionsOrCallback: Options | (() => unknown),
    maybeCallback?: () => unknown
  ) =>
    new Promise((resolve, reject) => {
      const [options, callback] =
        typeof optionsOrCallback === "function"
          ? [{} as Options, optionsOrCallback]
          : [optionsOrCallback, maybeCallback!]
      const lock = lockOf(name)
      const grant = () => {
        let settled = false
        const mine = {
          stolen: () => {
            settled = true
            reject(new DOMException("Lock stolen", "AbortError"))
          },
        }
        lock.holder = mine
        void Promise.resolve(callback()).then((value) => {
          if (settled) return
          settled = true
          lock.holder = undefined
          resolve(value)
          lock.waiting.shift()?.()
        })
      }
      if (options.steal === true) {
        lock.holder?.stolen()
        lock.holder = { stolen: () => undefined }
        return void setTimeout(grant, 0)
      }
      options.signal?.addEventListener("abort", () => {
        const index = lock.waiting.indexOf(grant)
        if (index === -1) return
        lock.waiting.splice(index, 1)
        reject(new DOMException("Aborted", "AbortError"))
      })
      if (lock.holder === undefined) {
        lock.holder = { stolen: () => undefined }
        setTimeout(grant, 0)
      } else lock.waiting.push(grant)
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

// A page in a tab of its own: its own modules, so its own stores, over the
// browser's one localStorage and locks. A recorded day's page is not live.
const openTab = async (live = true, settled = true) => {
  vi.resetModules()
  const { useBookAlerts } =
    await import("@/components/book-alerts/use-book-alerts")
  const held: { apply?: (message: ViewerDown) => void } = {}
  function Page() {
    held.apply = useBookAlerts(live)
    return null
  }
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  act(() => root.render(<Page />))
  if (settled) await settle()
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

test("a recorded day's page opened later takes no lock, so the live page still tells", async () => {
  browser()
  const radar = await openTab()
  await openTab(false)
  act(() => radar.hear(delta))
  await settle()
  expect(toasts.told, "the live radar keeps telling").toHaveLength(1)
})

test("the page whose window gains focus takes the lock", async () => {
  browser()
  const radar = await openTab()
  const marketLive = await openTab()
  // Both windows stay visible, so only focus says the radar came forward.
  act(() => void window.dispatchEvent(new Event("focus")))
  await settle()
  act(() => radar.hear(delta))
  await settle()
  expect(toasts.told, "the focused radar tells").toHaveLength(1)
  const later = deltaOf({ ...eaten, at: DateTime.makeUnsafe(T0 + 180_000) })
  act(() => marketLive.hear(later))
  await settle()
  expect(toasts.told, "the page left behind tells nothing").toHaveLength(1)
})

test("a page closed before its lock is granted lets the lock go", async () => {
  browser()
  const radar = await openTab()
  // Opened in front, it asks to take the lock, and closes before it is given.
  const marketLive = await openTab(true, false)
  marketLive.close()
  await settle()
  act(() => radar.hear(delta))
  await settle()
  expect(
    toasts.told,
    "the radar takes the lock back from the page that closed"
  ).toHaveLength(1)
})

test("a tab opened after an alert keeps the browser's cooldown", async () => {
  browser()
  const radar = await openTab()
  act(() => radar.hear(delta))
  await settle()
  const marketLive = await openTab()
  const soon = deltaOf({ ...eaten, at: DateTime.makeUnsafe(T0 + 30_000) })
  act(() => marketLive.hear(soon))
  await settle()
  expect(
    toasts.told,
    "the same code and kind 30 s later stays quiet in the new tab"
  ).toHaveLength(1)
})

test("a page reloaded within the minute keeps its count of 6", async () => {
  browser()
  const codes = ["AALI", "ADRO", "ANTM", "ASII", "BBNI", "BBRI", "BMRI"]
  window.localStorage.setItem(
    "kumora:book-alerts:rules",
    JSON.stringify([
      {
        id: "rule",
        kinds: ["eaten"],
        scope: { _tag: "codes", codes },
        minValue: 0,
      },
    ])
  )
  const ofCode = (code: string, i: number) =>
    deltaOf({
      ...eaten,
      code: StockCode.make(code),
      at: DateTime.makeUnsafe(T0 + i * 1_000),
    })
  const first = await openTab()
  act(() => {
    for (const [i, code] of codes.slice(0, 6).entries())
      first.hear(ofCode(code, i))
  })
  await settle()
  first.close()
  const reloaded = await openTab()
  act(() => reloaded.hear(ofCode("BMRI", 6)))
  await settle()
  expect(toasts.told.at(-1), "the seventh alert of the minute folds").toBe(
    "+1 more alerts this minute"
  )
})

// BBCA's readings at `at`: offer-heavy with big orders, or untagged.
const readingsAt = (at: number, tagged: boolean): BookReadings => ({
  code: StockCode.make("BBCA"),
  at: DateTime.makeUnsafe(at),
  imbalance: tagged ? -0.72 : 0.1,
  bid: { lots: tagged ? 1_400 : 5_500, lotsPerOrder: 22 },
  offer: { lots: tagged ? 8_600 : 4_500, lotsPerOrder: 118 },
})

// A delta carrying BBCA's readings at `at`, half a second after them.
const readingsDelta = (at: number, tagged: boolean): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(at + 500),
  tape: [],
  candles: [],
  bookReadings: [readingsAt(at, tagged)],
})

// A browser with Web Locks and one rule on BBCA of `kinds`.
const browserWith = (kinds: ReadonlyArray<string>, codes = ["BBCA"]) => {
  browser()
  window.localStorage.setItem(
    "kumora:book-alerts:rules",
    JSON.stringify([
      { id: "rule", kinds, scope: { _tag: "codes", codes }, minValue: 20e9 },
    ])
  )
}

test("a heavy side tag alerts when it appears, and not while it stays", async () => {
  browserWith(["bigOrders"])
  const radar = await openTab()
  act(() => {
    radar.hear(readingsDelta(T0, false))
    radar.hear(readingsDelta(T0 + 1_000, true))
  })
  await settle()
  act(() => radar.hear(readingsDelta(T0 + 180_000, true)))
  await settle()
  expect(toasts.told, "one alert, past the minimum value").toEqual([
    "BBCA · Offer-heavy with big orders",
  ])
})

test("a tag going to none and back within 2 minutes alerts once", async () => {
  browserWith(["bigOrders"])
  const radar = await openTab()
  act(() => {
    radar.hear(readingsDelta(T0, true))
    radar.hear(readingsDelta(T0 + 30_000, false))
    radar.hear(readingsDelta(T0 + 60_000, true))
  })
  await settle()
  expect(toasts.told, "the return cools").toHaveLength(1)
  act(() => {
    radar.hear(readingsDelta(T0 + 150_000, false))
    radar.hear(readingsDelta(T0 + 160_000, true))
  })
  await settle()
  expect(toasts.told, "a return past 2 minutes alerts again").toHaveLength(2)
})

test("a tag the page opened on doesn't alert", async () => {
  browserWith(["bigOrders"])
  const radar = await openTab()
  const snapshot = {
    _tag: "Snapshot",
    at: DateTime.makeUnsafe(T0 + 500),
    bookReadings: [readingsAt(T0, true)],
  } as unknown as ViewerDown
  act(() => {
    radar.hear(snapshot)
    radar.hear(readingsDelta(T0 + 1_000, true))
  })
  await settle()
  expect(toasts.told).toEqual([])
})

test("heavy side alerts share the minute's count with book events", async () => {
  const codes = ["AALI", "ADRO", "ANTM", "ASII", "BBNI", "BBRI", "BBCA"]
  browserWith(["eaten", "bigOrders"], codes)
  const radar = await openTab()
  act(() => {
    for (const [i, code] of codes.slice(0, 6).entries())
      radar.hear(
        deltaOf({
          ...eaten,
          code: StockCode.make(code),
          at: DateTime.makeUnsafe(T0 + i * 1_000),
        })
      )
  })
  await settle()
  act(() => radar.hear(readingsDelta(T0 + 6_000, true)))
  await settle()
  expect(toasts.told.at(-1), "the heavy side alert folds").toBe(
    "+1 more alerts this minute"
  )
})

test("a recorded day's page never tells a heavy side alert", async () => {
  browserWith(["bigOrders"])
  const recorded = await openTab(false)
  act(() => recorded.hear(readingsDelta(T0, true)))
  await settle()
  expect(toasts.told).toEqual([])
})
