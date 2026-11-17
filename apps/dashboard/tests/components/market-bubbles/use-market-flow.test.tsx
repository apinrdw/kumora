// @vitest-environment happy-dom
import type * as Client from "@workspace/client"
import {
  StockCode,
  WibDate,
  type Candle,
  type RecordedBubbles,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect, Option, Queue, Stream } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import {
  useFedMarketFlow,
  useMarketFlow,
} from "@/components/market-bubbles/use-market-flow"
import type { MarketFlow } from "@/lib/bubbles"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  socket: { messages: undefined as unknown },
  bubbles:
    vi.fn<
      (
        date: string,
        fresh: boolean
      ) => Effect.Effect<Option.Option<RecordedBubbles>>
    >(),
}))

vi.mock("@workspace/client", async (importOriginal) => ({
  ...(await importOriginal<typeof Client>()),
  fetchBubbles: (date: string, fresh: boolean) => mocks.bubbles(date, fresh),
  viewerMessages: () => mocks.socket.messages,
}))

afterEach(() => {
  vi.useRealTimers()
  mocks.bubbles.mockReset()
})

const MONDAY = WibDate.make("2026-11-16")
const TUESDAY = WibDate.make("2026-11-17")
const BBCA = StockCode.make("BBCA")
const BBRI = StockCode.make("BBRI")
const wib = (time: string) => Date.parse(`2026-11-16T${time}+07:00`)

// A snapshot sent now.
const snapshot = (): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe(Date.now()),
  selected: BBCA,
  tape: [],
  candles: [],
  footprints: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

const candle = (code: StockCode, at: number): Candle => ({
  code,
  minute: DateTime.makeUnsafe(at),
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 10,
  value: 100_000,
  buyValue: 0,
  sellValue: 0,
  frequency: 1,
})

const delta = (candles: ReadonlyArray<Candle>): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(Date.now()),
  tape: [],
  candles,
})

const answer = (
  codes: ReadonlyArray<StockCode>,
  settledBefore: number
): RecordedBubbles => ({
  settledBefore,
  codes: codes.map((code) => ({
    code,
    previousClose: 98,
    day: [100_000, 10, 1, 0, 0],
    minutes: [[wib("10:00:00"), 100_000, 10, 1, 0, 0, 100]],
  })),
})

// The Worker's body as served now: its newest build's, 5 s past the minute,
// settled before that build.
const built = (codes: ReadonlyArray<StockCode>) =>
  Effect.sync(() =>
    Option.some(
      answer(codes, Math.floor((Date.now() - 5_000) / 60_000) * 60_000 + 5_000)
    )
  )

// The hook in a page that gives it `today`, and what it returned last.
const mount = async (today: WibDate) => {
  const held: {
    flow?: MarketFlow
    apply?: (message: ViewerDown) => void
  } = {}
  function Harness({ day }: { day: WibDate }) {
    Object.assign(held, useFedMarketFlow(day, 0))
    return null
  }
  const root = createRoot(document.createElement("div"))
  await act(() => root.render(<Harness day={today} />))
  return {
    held,
    show: (day: WibDate) => act(() => root.render(<Harness day={day} />)),
    unmount: () => act(() => root.unmount()),
  }
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(20))

test("a new day starts an empty market flow", async () => {
  vi.useFakeTimers({ now: wib("10:00:30") })
  mocks.bubbles.mockReturnValue(built([BBCA]))
  const page = await mount(MONDAY)
  act(() => page.held.apply!(snapshot()))
  await settle()
  expect([...page.held.flow!.codes.keys()]).toEqual([BBCA])

  await page.show(TUESDAY)
  expect(page.held.flow!.codes.size).toBe(0)
  await page.unmount()
})

test("a snapshot drops the backfill the one before it still asks", async () => {
  vi.useFakeTimers({ now: wib("10:00:30") })
  const dropped = vi.fn<() => void>()
  mocks.bubbles.mockReturnValueOnce(
    Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(dropped)))
  )
  mocks.bubbles.mockReturnValue(Effect.succeed(Option.none()))
  const page = await mount(MONDAY)
  act(() => page.held.apply!(snapshot()))
  await settle()
  act(() => page.held.apply!(snapshot()))
  await settle()
  expect(dropped).toHaveBeenCalledOnce()
  await page.unmount()
})

test("its own socket's snapshot drops the backfill the one before it follows", async () => {
  vi.useFakeTimers({ now: wib("10:00:30") })
  const socket = Effect.runSync(Queue.unbounded<ViewerDown>())
  mocks.socket.messages = Stream.fromQueue(socket)
  const dropped = vi.fn<() => void>()
  mocks.bubbles.mockReturnValueOnce(
    Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(dropped)))
  )
  mocks.bubbles.mockReturnValue(Effect.succeed(Option.none()))
  function Harness() {
    useMarketFlow(MONDAY, 0)
    return null
  }
  const root = createRoot(document.createElement("div"))
  await act(() => root.render(<Harness />))
  Queue.offerUnsafe(socket, snapshot())
  await settle()
  Queue.offerUnsafe(socket, snapshot())
  await settle()
  expect(mocks.bubbles).toHaveBeenCalledTimes(2)
  expect(dropped).toHaveBeenCalledOnce()
  await act(() => root.unmount())
})

test("asks the backfill again, past the browser's copy, after the next minute's build", async () => {
  vi.useFakeTimers({ now: wib("10:00:30") })
  mocks.bubbles.mockReturnValue(built([BBCA]))
  const page = await mount(MONDAY)
  act(() => page.held.apply!(snapshot()))
  await settle()
  expect(mocks.bubbles.mock.calls).toEqual([[MONDAY, false]])

  // The build runs 5 s past 10:01; the page asks a second after it.
  await act(() => vi.advanceTimersByTimeAsync(wib("10:01:05") - Date.now()))
  expect(mocks.bubbles).toHaveBeenCalledTimes(1)
  await act(() => vi.advanceTimersByTimeAsync(1_000))
  expect(mocks.bubbles.mock.calls).toEqual([
    [MONDAY, false],
    [MONDAY, true],
  ])

  // Settled past the snapshot, with every code's previous close: no ask at
  // the next build.
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.bubbles).toHaveBeenCalledTimes(2)
  await page.unmount()
})

test("asks after each build until a body settled past the snapshot comes", async () => {
  vi.useFakeTimers({ now: wib("10:00:30") })
  // Built while the snapshot's trades were in their merge window.
  mocks.bubbles.mockReturnValue(
    Effect.succeed(Option.some(answer([BBCA], wib("10:00:28"))))
  )
  const page = await mount(MONDAY)
  act(() => page.held.apply!(snapshot()))
  await act(() => vi.advanceTimersByTimeAsync(wib("10:01:06") - Date.now()))
  expect(mocks.bubbles).toHaveBeenCalledTimes(2)

  mocks.bubbles.mockReturnValue(built([BBCA]))
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.bubbles).toHaveBeenCalledTimes(3)
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.bubbles).toHaveBeenCalledTimes(3)
  await page.unmount()
})

test("asks the backfill again after the next build for a code it hasn't carried, for its previous close", async () => {
  vi.useFakeTimers({ now: wib("10:00:30") })
  mocks.bubbles.mockReturnValue(built([BBCA]))
  const page = await mount(MONDAY)
  act(() => page.held.apply!(snapshot()))
  await settle()
  await act(() => vi.advanceTimersByTimeAsync(wib("10:01:06") - Date.now()))
  expect(mocks.bubbles).toHaveBeenCalledTimes(2)

  // BBRI first trades at 10:01.
  act(() => page.held.apply!(delta([candle(BBRI, wib("10:01:00"))])))
  mocks.bubbles.mockReturnValue(built([BBCA, BBRI]))
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.bubbles.mock.calls.at(-1)).toEqual([MONDAY, true])
  expect(mocks.bubbles).toHaveBeenCalledTimes(3)
  expect(page.held.flow!.codes.get(BBRI)?.previousClose).toBe(98)

  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.bubbles).toHaveBeenCalledTimes(3)
  await page.unmount()
})

test("gives up on a code's previous close after three backfills without it", async () => {
  vi.useFakeTimers({ now: wib("10:00:30") })
  mocks.bubbles.mockReturnValue(built([BBCA]))
  const page = await mount(MONDAY)
  act(() => page.held.apply!(snapshot()))
  await settle()
  await act(() => vi.advanceTimersByTimeAsync(wib("10:01:06") - Date.now()))
  expect(mocks.bubbles).toHaveBeenCalledTimes(2)

  // BBRI trades at 10:01, and no backfill ever carries its previous close.
  act(() => page.held.apply!(delta([candle(BBRI, wib("10:01:00"))])))
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
  expect(mocks.bubbles).toHaveBeenCalledTimes(5)
  expect(page.held.flow!.codes.get(BBRI)?.previousClose).toBeUndefined()

  // A reconnect asks again, as each snapshot does, but no more for BBRI.
  act(() => page.held.apply!(snapshot()))
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
  expect(mocks.bubbles).toHaveBeenCalledTimes(7)
  await page.unmount()
})

test("stops asking after five fresh backfills in a row that leave it waiting, until the next snapshot", async () => {
  vi.useFakeTimers({ now: wib("10:00:30") })
  // A Worker whose body never settles past the snapshot.
  mocks.bubbles.mockReturnValue(
    Effect.succeed(Option.some(answer([BBCA], wib("10:00:28"))))
  )
  const page = await mount(MONDAY)
  act(() => page.held.apply!(snapshot()))
  await act(() => vi.advanceTimersByTimeAsync(30 * 60_000))
  expect(mocks.bubbles).toHaveBeenCalledTimes(6)

  act(() => page.held.apply!(snapshot()))
  await act(() => vi.advanceTimersByTimeAsync(30 * 60_000))
  expect(mocks.bubbles).toHaveBeenCalledTimes(12)
  await page.unmount()
})
