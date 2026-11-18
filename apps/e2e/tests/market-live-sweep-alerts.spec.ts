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
// 659 Hz a sell's (sweep-alert-sound.ts).
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
    state = "running"
    currentTime = 0
    destination = {}
    resume = () => Promise.resolve()
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
const BUY_FIRST_NOTE = 1047

test("a sweep that reaches its code's top-1% cutoff marks its rows on the live tape and plays one buy sound, though another code is selected", async ({
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
  // 100 one-lot sweeps a side: alternate sides, so each trade is a sweep.
  const warm = Array.from({ length: 200 }, (_, index) =>
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
  const big = [201, 202].map((seq) =>
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
    seq: base + 203,
    time: laterAt!,
    ticker: code,
    price: 500,
    lot: 1,
    type: "SELL",
  })
  await relay.sendAjaib([...warm, ...big, later])

  for (const seq of [201, 202]) {
    await expect(row(seq)).toHaveAttribute("data-sweep-alert", "buy")
    const mark = row(seq).locator("td").first().locator("[data-sweep-alert]")
    await expect(mark).toHaveText("▲")
    await expect(mark).toHaveClass(/text-up/)
  }
  // The warm-up's last sweeps alert nothing: each had 99 earlier.
  for (const seq of [199, 200])
    await expect(row(seq)).not.toHaveAttribute("data-sweep-alert")
  // The big buy sweep sounded once. The later sell trade can alert too, once
  // another spec's trade closes its second, so only buys are counted.
  await expect
    .poll(() =>
      page.evaluate(
        (buy) => window.__notes?.filter((hz) => hz === buy).length,
        BUY_FIRST_NOTE
      )
    )
    .toBe(1)
  relay.close()
})
