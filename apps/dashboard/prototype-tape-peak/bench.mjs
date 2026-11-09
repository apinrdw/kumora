// PROTOTYPE, throw away. Headless benchmark of the three tape variants; serve this folder on :4173 first.
import { chromium } from "playwright"

const browser = await chromium.launch()
const out = {}
const runs = [["A", 1, 10000], ["A", 4, 200000], ["B", 1, 500], ["B", 1, 3000], ["B", 4, 3000], ["C", 4, 200000]]
for (const cpu of [1, 4]) {
  for (const [variant, stressX, keepN] of runs) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
    await page.goto(`http://127.0.0.1:4173/?variant=${variant}`)
    await page.evaluate(([s, k]) => { stress = s; keep = k; reset(0) }, [stressX, keepN])
    await page.evaluate(() => {
      window.__ft = []
      let last = performance.now()
      const tick = (now) => { window.__ft.push(now - last); last = now; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    // Covers the 08:58 match delivery (08:58:01–08:58:13).
    await page.waitForTimeout(13000)
    out[`cpu${cpu}x ${variant} stress${stressX} keep${keepN}`] = await page.evaluate(() => {
      const ft = window.__ft.slice(1).sort((x, y) => x - y)
      const q = (p) => ft[Math.floor(ft.length * p)].toFixed(1)
      return `p50 ${q(0.5)} ms, p99 ${q(0.99)} ms, max ${ft.at(-1).toFixed(0)} ms, worstApply ${worstApply.toFixed(1)} ms, longTasks ${longTasks}, peakDelta ${Math.max(...deltaSizes)}`
    })
    await page.close()
  }
}
await browser.close()
console.log(JSON.stringify(out, null, 1))
