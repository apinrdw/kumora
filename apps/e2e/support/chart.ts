import type { Locator } from "@playwright/test"

/**
 * The pixels chart 1's volume pane draws in green (buy lots) and in red
 * (sell lots): its canvases are the wide ones in the lower half of the
 * chart, below the candles' pane. Greyed and no-side bars count in neither.
 */
export const volumeInk = (chart: Locator) =>
  chart.evaluate((host) => {
    const box = host.getBoundingClientRect()
    const ink = { buy: 0, sell: 0 }
    for (const canvas of host.querySelectorAll("canvas")) {
      const rect = canvas.getBoundingClientRect()
      if (rect.top < box.top + box.height / 2 || rect.width < box.width / 2)
        continue
      const context = canvas.getContext("2d")
      if (context === null || canvas.width === 0 || canvas.height === 0)
        continue
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < data.length; i += 4) {
        const [red, green, alpha] = [data[i]!, data[i + 1]!, data[i + 3]!]
        if (alpha < 128) continue
        if (green - red > 60) ink.buy++
        else if (red - green > 60) ink.sell++
      }
    }
    return ink
  })

/**
 * Where chart 1 last drew the replay cursor line, in CSS px from the plot's
 * left edge: `x`, its minute's centre and the bar spacing.
 */
export const cursorPlace = async (chart: Locator) => {
  const read = async (name: string) =>
    Number(await chart.getAttribute(`data-${name}`))
  return {
    x: await read("cursor-x"),
    minute: await read("cursor-minute-x"),
    spacing: await read("bar-spacing"),
  }
}
