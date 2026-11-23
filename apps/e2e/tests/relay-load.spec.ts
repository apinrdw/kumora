import type { Connection } from "@workspace/relay"
import {
  SESSION_1,
  STOCKBIT_TAB,
  TICKS,
  launchWithExtension,
  setRelayClock,
  startFakeBrokers,
  startFakeIngest,
  tickRelay,
} from "../support/relay-extension"
import { expect, test } from "../support/test"

// About twice the real 09:00 peak, per Stockbit connection, for
// longer than the relay's 10 s tick. A burst-then-collapse load would flake:
// a burst collapses the timer-clamped relay of apinrdw/kumora#229 only about
// 60% of the time. See apinrdw/kumora#233.
const FRAMES_PER_SECOND = 2_000
const SECONDS = 15
// A relay that keeps up holds about 260 ms at p99, most of it the 250 ms
// batch.
const P99_BAR_MS = 1_000
// How long the frames still in the relay get to arrive once the load ends.
// A relay that keeps up needs one batch; one that fell behind gets enough
// that the figures show how far.
const DRAIN_MS = 15_000
// Opaque bytes the relay forwards unparsed, about a real frame's size.
const FRAME_BYTES = 600

// A load frame: a marker byte that no fake broker reply starts with, then its
// send time and number as ASCII digits.
const MARKER = 0x54
const TIME_DIGITS = 13
const NUMBER_DIGITS = 6

const loadFrame = (number: number, sentAt: number) => {
  const bytes = new Uint8Array(FRAME_BYTES).fill(0x41)
  bytes[0] = MARKER
  bytes.set(
    new TextEncoder().encode(
      String(sentAt).padStart(TIME_DIGITS, "0") +
        String(number).padStart(NUMBER_DIGITS, "0")
    ),
    1
  )
  return bytes
}

const readLoadFrame = (bytes: Uint8Array) => {
  if (bytes[0] !== MARKER) return undefined
  const digits = new TextDecoder().decode(
    bytes.subarray(1, 1 + TIME_DIGITS + NUMBER_DIGITS)
  )
  return {
    sentAt: Number(digits.slice(0, TIME_DIGITS)),
    number: Number(digits.slice(TIME_DIGITS)),
  }
}

const quantile = (sorted: ReadonlyArray<number>, q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN

test("the relay carries 2,000 Stockbit frames a second on each connection to ingest within 1 s", async () => {
  test.setTimeout(120_000)
  const brokers = await startFakeBrokers()
  const ingest = await startFakeIngest()
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    await setRelayClock(worker, SESSION_1)
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Extra target URL").fill(ingest.origin)
    await options.getByLabel("Extra target ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect.poll(() => ingest.sockets.length).toBe(1)
    const tab = await context.newPage()
    await tab.goto(STOCKBIT_TAB)

    // B opens only once A streams, so A carries a frame first.
    const trade = () =>
      brokers.on("/ws").filter(({ socket }) => socket.readyState === 1)
    await expect.poll(() => trade().length, TICKS).toBe(1)
    for (const { socket } of trade()) socket.send(new Uint8Array([0]))
    await expect
      .poll(async () => {
        await tickRelay(worker)
        return trade().length
      }, TICKS)
      .toBe(2)

    // Every millisecond, both connections get the frames due by then.
    const sockets = trade()
    const start = Date.now()
    const total = FRAMES_PER_SECOND * SECONDS
    let sent = 0
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const due = Math.min(
          total,
          Math.floor(((Date.now() - start) / 1000) * FRAMES_PER_SECOND)
        )
        for (; sent < due; sent++) {
          const frame = loadFrame(sent, Date.now())
          for (const { socket } of sockets) socket.send(frame)
        }
        if (sent === total) {
          clearInterval(timer)
          resolve()
        }
      }, 1)
    })

    // Every frame, once per connection, and how late each arrived.
    const arrivals = async () => {
      const byConnection = new Map<Connection, Set<number>>()
      const lags: Array<number> = []
      for (const { message, at } of await ingest.messages()) {
        if (message._tag !== "Frames" || message.feed !== "Stockbit") continue
        const numbers = byConnection.get(message.connection) ?? new Set()
        byConnection.set(message.connection, numbers)
        for (const bytes of message.frames) {
          const frame = readLoadFrame(bytes)
          if (frame === undefined) continue
          numbers.add(frame.number)
          lags.push(at - frame.sentAt)
        }
      }
      return {
        perConnection: [...byConnection.values()].map(
          (numbers) => numbers.size
        ),
        lags: lags.sort((a, b) => a - b),
      }
    }
    const drainedBy = Date.now() + DRAIN_MS
    let carried = await arrivals()
    while (
      carried.perConnection.some((count) => count < total) &&
      Date.now() < drainedBy
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      carried = await arrivals()
    }

    const { perConnection, lags } = carried
    const measured = `${perConnection.join(" + ")} of ${total} + ${total} frames arrived; delivery lag p50 ${quantile(lags, 0.5)} ms, p99 ${quantile(lags, 0.99)} ms, max ${lags.at(-1)} ms`
    console.log(`relay load: ${measured}`)
    expect(perConnection, measured).toEqual([total, total])
    expect(quantile(lags, 0.99), measured).toBeLessThan(P99_BAR_MS)
  } finally {
    await context.close()
    await ingest.close()
    await brokers.close()
  }
})
