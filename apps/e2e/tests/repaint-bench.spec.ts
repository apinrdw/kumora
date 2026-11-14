// The peak repaint bench of spec apinrdw/kumora#263 (ticket
// apinrdw/kumora#272): with VKTR's busy open on both charts, at 4× CPU
// slowdown, each chart's full repaint stays within a 60 Hz frame at p95
// over a 120-frame pan at the default zoom.
import { DASHBOARD, MEMBER } from "../support/accounts"
import { VKTR_OPEN, vktrBook, vktrOpenTape } from "../support/busy-open"
import { marketNow } from "../support/clock"
import { freshCode, freshTradeNumbers, openIngest } from "../support/ingest"
import { expect, test } from "../support/test"

const CPU_SLOWDOWN = 4
const FRAMES = 120
const P95_BAR_MS = 16
// Chart 2 draws its widest view, `sell × buy` text, at this size.
const VIEWPORT = { width: 1920, height: 1080 }
// Frames a send carries: about 200 KB of Ajaib JSON.
const BATCH = 1_000
// How long the bench serves books, one every half second, so the minutes it
// spans carry a heatmap as dense as VKTR's book.
const BOOK_SECONDS = 15

test.use({ storageState: MEMBER.storageState })

declare global {
  interface Window {
    // Every chart repaint while recording: the chart it drew and its ms.
    __repaints?: Array<{ chart: string; ms: number }>
  }
}

// Times each animation-frame callback that draws a chart's canvas: one
// Lightweight Charts paint, start to end, attributed to the chart whose
// host (`data-chart`) holds the canvas it first takes a context of. Each
// chart paints in a callback of its own (ChartWidget's `_drawPlanned`), and
// takes every canvas's context afresh each paint (fancy-canvas).
const timeRepaints = () => {
  const request = window.requestAnimationFrame.bind(window)
  let current: { chart?: string } | undefined
  window.requestAnimationFrame = (callback) =>
    request((time) => {
      const painted: { chart?: string } = {}
      current = painted
      const start = performance.now()
      try {
        callback(time)
      } finally {
        current = undefined
        if (painted.chart !== undefined)
          window.__repaints?.push({
            chart: painted.chart,
            ms: performance.now() - start,
          })
      }
    })
  const getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    ...args: Parameters<typeof getContext>
  ) {
    if (current !== undefined && current.chart === undefined)
      current.chart =
        this.closest("[data-chart]")?.getAttribute("data-chart") ?? undefined
    return getContext.apply(this, args)
  } as typeof getContext
}

const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

test("both charts repaint within 16 ms at p95 on VKTR's open at 4× CPU slowdown", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const code = freshCode("VK")
  const now = marketNow()
  const tape = vktrOpenTape(code, freshTradeNumbers(), now)
  const relay = await openIngest()
  for (let from = 0; from < tape.length; from += BATCH)
    await relay.sendAjaib(tape.slice(from, from + BATCH))
  // The books, served as the page opens and draws.
  const books = (async () => {
    for (let half = 0; half < BOOK_SECONDS * 2; half++) {
      await relay.sendAjaib([
        vktrBook(code, VKTR_OPEN.firstPrice, marketNow(), half),
      ])
      await page.waitForTimeout(500)
    }
  })()

  await page.addInitScript(timeRepaints)
  await page.setViewportSize(VIEWPORT)
  await page.goto(`${DASHBOARD}/market-live?code=${code}`)
  const footprint = page.getByRole("region", { name: "Footprint" })
  await expect(footprint).toContainText(
    `Footprint minutes: ${VKTR_OPEN.minutes}`,
    { timeout: 30_000 }
  )
  const chart1 = page.locator('[data-chart="candles"]')
  const chart2 = page.locator('[data-chart="footprint"]')
  await expect(chart1).toHaveAttribute("data-bubbles", /^[1-9]\d*$/)
  await expect(chart2).toHaveAttribute("data-draw-mode", "text")
  await books
  relay.close()
  await expect(chart1).toHaveAttribute("data-heatmap-slices", /^[1-9]\d*$/)
  const drawn = {
    bubbles: await chart1.getAttribute("data-bubbles"),
    heatSlices: await chart1.getAttribute("data-heatmap-slices"),
    imbalances: await chart2.getAttribute("data-imbalances"),
    vwapPoints: await chart2.getAttribute("data-vwap-points"),
  }

  // A day's thousands of sweeps scroll inside the log: they never stretch
  // the charts beside it past the window.
  for (const chart of [chart1, chart2])
    expect((await chart.boundingBox())!.height).toBeLessThan(VIEWPORT.height)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN })
  // Chart 2 leads: a sine of ±1.5 of its bars, which chart 1 follows minute
  // for minute through the pair. Each step is one mouse move, then two
  // frames, so each frame paints both charts once.
  await chart2.scrollIntoViewIfNeeded()
  const box = (await chart2.boundingBox())!
  const amplitude = (box.width / VKTR_OPEN.minutes) * 1.5
  const x = box.x + box.width / 2
  const y = box.y + box.height * 0.4
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.evaluate(() => (window.__repaints = []))
  for (let frame = 0; frame < FRAMES; frame++) {
    await page.mouse.move(
      x + Math.sin((frame / FRAMES) * 2 * Math.PI) * amplitude,
      y
    )
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done))
        )
    )
  }
  const repaints = await page.evaluate(() => window.__repaints ?? [])
  await page.mouse.up()
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })

  const of = (chart: string) =>
    repaints.filter((repaint) => repaint.chart === chart).map((r) => r.ms)
  const figures = Object.fromEntries(
    ["candles", "footprint"].map((chart) => {
      const ms = of(chart)
      return [
        chart,
        {
          repaints: ms.length,
          p50: quantile(ms, 0.5),
          p95: quantile(ms, 0.95),
          max: Math.max(...ms),
        },
      ]
    })
  )
  const report = JSON.stringify({ cpuSlowdown: CPU_SLOWDOWN, drawn, figures })
  test.info().annotations.push({ type: "repaint", description: report })
  console.log(`Repaint bench: ${report}`)

  for (const chart of ["candles", "footprint"]) {
    // Each frame of the pan repainted the chart.
    expect(of(chart).length).toBeGreaterThanOrEqual(FRAMES * 0.9)
    expect(
      quantile(of(chart), 0.95),
      `${chart} p95 repaint ms`
    ).toBeLessThanOrEqual(P95_BAR_MS)
  }
})
