// @vitest-environment happy-dom
import type * as Client from "@workspace/client"
import { WibDate, type RecordedDay } from "@workspace/relay"
import { Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { MarketStripBar } from "@/components/market-bubbles/market-strip-bar"
import { makeMarketFlow } from "@/lib/bubbles"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchDayStrip:
    vi.fn<(fresh?: boolean) => Effect.Effect<ReadonlyArray<RecordedDay>>>(),
}))

vi.mock("@workspace/client", async (importOriginal) => ({
  ...(await importOriginal<typeof Client>()),
  fetchDayStrip: (fresh = false) =>
    Effect.suspend(() => mocks.fetchDayStrip(fresh)),
}))

afterEach(() => {
  vi.useRealTimers()
  mocks.fetchDayStrip.mockReset()
})

const FRIDAY = WibDate.make("2026-11-13")
const MONDAY = WibDate.make("2026-11-16")
const TUESDAY = WibDate.make("2026-11-17")

const row = (day: WibDate, close: number): RecordedDay => ({
  day,
  ihsg: { close, change: 0, changePercent: 0 },
  trades: 1,
  gap: false,
})

test("IHSG's change follows the sealed day the live date turned over", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-16T10:00:00+07:00") })
  // Monday morning's list ends at Friday; Tuesday's has Monday sealed.
  mocks.fetchDayStrip.mockReturnValueOnce(Effect.succeed([row(FRIDAY, 8_000)]))
  mocks.fetchDayStrip.mockReturnValue(
    Effect.succeed([row(MONDAY, 8_100), row(FRIDAY, 8_000)])
  )
  const flow = Effect.runSync(makeMarketFlow())
  const container = document.createElement("div")
  const root = createRoot(container)
  const show = (today: WibDate) =>
    act<void>(() =>
      root.render(
        <MarketStripBar
          flow={flow}
          ihsg={8_181}
          today={today}
          phase="session-1"
          clockOffset={0}
        />
      )
    )
  const ihsg = () =>
    container.querySelector('[aria-label="IHSG"]')?.textContent ?? ""
  await show(MONDAY)
  expect(ihsg()).toContain("+2.26%")

  await show(TUESDAY)
  await act(() => vi.advanceTimersByTimeAsync(20))
  expect(mocks.fetchDayStrip).toHaveBeenCalledTimes(2)
  expect(ihsg()).toContain("+1.00%")
  await act<void>(() => root.unmount())
})
