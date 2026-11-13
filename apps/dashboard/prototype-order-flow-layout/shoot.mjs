// PROTOTYPE helper: screenshots each variant and benches chart repaints in headless Chromium.
// Serve this folder first (python3 -m http.server 8765), then: node shoot.mjs <path to playwright package>
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { chromium } = require(process.argv[2] ?? "playwright")
const base = "http://localhost:8765/"
const out = new URL(".", import.meta.url).pathname
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })
const errors = []
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
page.on("pageerror", (e) => errors.push(String(e)))
const results = {}
for (const v of ["A", "B", "C"]) {
  await page.goto(`${base}?variant=${v}&zoom=busy&cursor=14:30`)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}variant-${v}.png`, fullPage: true })
  results[v] = { busy: await page.evaluate(() => window.__bench(120)) }
  results[v].busyState = await page.evaluate(() => document.getElementById("state").innerText)
  await page.evaluate(() => window.__zoom("day"))
  await page.waitForTimeout(300)
  results[v].day = await page.evaluate(() => window.__bench(120))
  results[v].state = await page.evaluate(() => document.getElementById("state").innerText)
}
// close zoom, where the footprint switches to text
await page.goto(`${base}?variant=B&zoom=open15&cursor=09:12`)
await page.waitForFunction(() => window.__ready === true)
await page.waitForTimeout(300)
await page.evaluate(() => window.__zoom("open15"))
await page.waitForTimeout(300)
results.open15 = await page.evaluate(() => window.__bench(120))
results.open15State = await page.evaluate(() => document.getElementById("state").innerText)
await page.screenshot({ path: `${out}variant-B-open15.png`, fullPage: true })
// row click: jump both charts to a big-trade sweep and ring it
await page.goto(`${base}?variant=A&zoom=day&cursor=15:50`)
await page.waitForFunction(() => window.__ready === true)
await page.waitForTimeout(300)
results.clicked = await page.evaluate(() => window.__selectFirstBigRow())
await page.waitForTimeout(400)
// hover chart 1 to show the synced crosshair and the readout
const box = await page.locator("#c1").boundingBox()
await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4)
await page.waitForTimeout(300)
await page.screenshot({ path: `${out}variant-A-row-click.png`, fullPage: true })
results.clickState = await page.evaluate(() => document.getElementById("state").innerText)
console.log(JSON.stringify({ results, errors }, null, 2))
await browser.close()
