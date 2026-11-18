import { DASHBOARD, MEMBER } from "../support/accounts"
import { marketNow, wibTime } from "../support/clock"
import {
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
} from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"

test.use({ storageState: MEMBER.storageState })

declare global {
  interface Window {
    // The starting frequency of each note the page played, in Hz.
    __notes?: Array<number>
  }
}

// Stands in for WebAudio: each note the page plays is written down by its
// starting frequency. A sound's first note names it: 1047 Hz is a buy's,
// 659 Hz a sell's (sweep-alert-sound.ts). As in a browser, a context starts
// suspended until the page's click resumes it.
const recordNotes = () => {
  const notes: Array<number> = []
  window.__notes = notes
  const param = (record?: (hz: number) => void) => ({
    setValueAtTime: (value: number) => record?.(value),
    exponentialRampToValueAtTime: () => undefined,
  })
  const node = <T extends object>(fields: T) => ({
    ...fields,
    connect: <N>(next: N) => next,
  })
  class RecordingAudioContext {
    state = "suspended"
    currentTime = 0
    destination = {}
    resume = () => {
      this.state = "running"
      return Promise.resolve()
    }
    createOscillator = () =>
      node({
        type: "sine",
        frequency: param((hz) => notes.push(hz)),
        start: () => undefined,
        stop: () => undefined,
      })
    createGain = () => node({ gain: param() })
  }
  window.AudioContext = RecordingAudioContext as unknown as typeof AudioContext
}
// A buy's first note, as `NOTES.buy` in
// apps/dashboard/src/components/market-live/sweep-alert-sound.ts.
const BUY_FIRST_NOTE = 1047
// The sweeps a side holds before it can alert, as `WARM_UP` in
// apps/dashboard/src/server/market-live/sweep-alerts.ts.
const WARM_UP = 100
// The warm-up's trades: a sweep each, the sides in turn.
const WARMING = WARM_UP * 2

test("a sweep that reaches its code's top-1% cutoff marks its rows on the live tape and plays one buy sound, though another code is selected, and is marked again silently after a reload, where an alert before the first click never plays", async ({
  page,
}) => {
  const relay = await openIngest()
  const base = freshTradeNumbers()
  // A code of its own: today's object ranks every code's sweeps all day.
  const code = freshCode("SL")
  await page.addInitScript(recordNotes)
  await page.goto(`${DASHBOARD}${PAGE}`)
  const tape = page.getByRole("region", { name: "Running trades" })
  const row = (seq: number) =>
    tape.locator(`tr[data-trade-number="${base + seq}"]`)
  // A live alert reaches only an open socket: another code's trade shows
  // first, so the page is live before the sweeps go out.
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1_000,
      time: wibTime(marketNow()),
      ticker: freshCode("SQ"),
      price: 500,
      lot: 1,
    }),
  ])
  await expect(row(1_000)).toBeVisible()
  // Sound is off until the member turns it on. The live row says the page
  // has hydrated, so the click reaches the toggle.
  const speaker = tape.getByRole("button", { name: "Sweep alert sound" })
  await expect(speaker).toHaveAttribute("aria-pressed", "false")
  await speaker.click()
  await expect(speaker).toHaveAttribute("aria-pressed", "true")

  // Three seconds in a row on the market clock: the warm-up's, the big
  // sweep's, and a later trade's, which closes the big sweep's second.
  const now = marketNow()
  const [warmAt, bigAt, laterAt] = [now - 2_000, now - 1_000, now].map(wibTime)
  // The warm-up, in one-lot sweeps: alternate sides, so each trade is a
  // sweep.
  const warm = Array.from({ length: WARMING }, (_, index) =>
    ajaibTradeToday({
      seq: base + index + 1,
      time: warmAt!,
      ticker: code,
      price: 500,
      lot: 1,
      type: index % 2 === 0 ? "BUY" : "SELL",
    })
  )
  // A buy sweep of two trades: 30 lots against a cutoff of 1.
  const bigSeqs = [WARMING + 1, WARMING + 2]
  const big = bigSeqs.map((seq) =>
    ajaibTradeToday({
      seq: base + seq,
      time: bigAt!,
      ticker: code,
      price: 505,
      lot: 15,
      type: "BUY",
    })
  )
  const later = ajaibTradeToday({
    seq: base + WARMING + 3,
    time: laterAt!,
    ticker: code,
    price: 500,
    lot: 1,
    type: "SELL",
  })
  await relay.sendAjaib([...warm, ...big, later])

  const marked = async () => {
    for (const seq of bigSeqs) {
      await expect(row(seq)).toHaveAttribute("data-sweep-alert", "buy")
      const mark = row(seq).locator("td").first().locator("[data-sweep-alert]")
      await expect(mark).toHaveText("▲")
      await expect(mark).toHaveClass(/text-up/)
    }
    // The warm-up's last sweeps alert nothing: each had one too few
    // earlier.
    for (const seq of [WARMING - 1, WARMING])
      await expect(row(seq)).not.toHaveAttribute("data-sweep-alert")
  }
  // The buy sounds since the page loaded. The later sell trade can alert
  // too, once another spec's trade closes its second, so only buys count.
  const buys = () =>
    page.evaluate(
      (buy) => window.__notes?.filter((hz) => hz === buy).length,
      BUY_FIRST_NOTE
    )
  await marked()
  // The big buy sweep sounded once.
  await expect.poll(buys).toBe(1)

  // A reload starts the tape over from a snapshot, which carries the alert.
  await page.reload()
  await marked()
  // The toggle is remembered, and the snapshot's alert stays silent.
  await expect(speaker).toHaveAttribute("aria-pressed", "true")
  expect(await buys()).toBe(0)

  // Before the reloaded page's first click its sound is suspended: a new
  // alert marks its rows but plays neither then nor at the first key press.
  const [againAt, closedAt] = [marketNow() - 1_000, marketNow()].map(wibTime)
  await relay.sendAjaib([
    ...[301, 302].map((seq) =>
      ajaibTradeToday({
        seq: base + seq,
        time: againAt!,
        ticker: code,
        price: 505,
        lot: 15,
        type: "BUY",
      })
    ),
    ajaibTradeToday({
      seq: base + 303,
      time: closedAt!,
      ticker: code,
      price: 500,
      lot: 1,
      type: "SELL",
    }),
  ])
  await expect(row(301)).toHaveAttribute("data-sweep-alert", "buy")
  expect(await buys()).toBe(0)
  await page.keyboard.press("Shift")
  expect(await buys()).toBe(0)
  relay.close()
})
