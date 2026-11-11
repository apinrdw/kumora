import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { CandlestickChart } from "@/components/k/charts/candlestick-chart"
import type { Candle } from "@/domain/quote"

const candles: Array<Candle> = [
  { label: "13 Okt", o: 9200, h: 9300, l: 9150, c: 9275, v: 1000, vwap: 9240 },
  { label: "14 Okt", o: 9275, h: 9280, l: 9100, c: 9125, v: 3000, vwap: 9180 },
  { label: "15 Okt", o: 9125, h: 9225, l: 9100, c: 9200, v: 2000 },
]

function render(props: Partial<Parameters<typeof CandlestickChart>[0]> = {}) {
  return renderToStaticMarkup(<CandlestickChart data={candles} {...props} />)
}

describe("CandlestickChart", () => {
  test("renders nothing without candles", () => {
    expect(render({ data: [] })).toBe("")
  })

  test("the readout shows the latest candle before any interaction", () => {
    const html = render()
    expect(html).toContain('aria-valuetext="15 Okt"')
    expect(html).toContain('aria-valuenow="2"')
    expect(html).toMatch(/class="text-up">C Rp9,200</)
    expect(html).toContain("Vol 2 K shares")
  })

  test("a down candle and an up candle use the matching semantic color", () => {
    const html = render()
    expect(html).toContain('fill="var(--semantic-up)"')
    expect(html).toContain('fill="var(--semantic-down)"')
  })

  test("the VWAP line joins consecutive candles and breaks where one has no VWAP", () => {
    const vwapPath = (data: Array<Candle>) =>
      render({ data }).match(/<path d="([^"]*)"/)?.[1]
    expect(vwapPath(candles)).toBe("M104.0 50.6 L296.0 93.2 ")
    const gap = candles.map((c, i) => ({
      ...c,
      vwap: i === 1 ? undefined : 9200,
    }))
    expect(vwapPath(gap)?.match(/[ML]/g)).toEqual(["M", "M"])
  })

  test("VWAP and volume can be switched off", () => {
    const html = render({ showVwap: false, showVolume: false })
    expect(html).not.toContain("<path")
    expect(html).not.toContain('fill="var(--chart-volume)"')
    expect(html).not.toContain(">Vol</text>")
  })

  test("candles without VWAP or volume draw neither overlay", () => {
    const html = render({
      data: candles.map(({ label, o, h, l, c }) => ({ label, o, h, l, c })),
    })
    expect(html).not.toContain("<path")
    expect(html).not.toContain(">Vol</text>")
    expect(html).not.toContain("Vol ")
  })

  test("labelEvery controls which candles get an axis label", () => {
    const labels = (html: string) =>
      [...html.matchAll(/text-anchor="middle"[^>]*>([^<]+)</g)].map((m) => m[1])
    expect(labels(render({ labelEvery: 2 }))).toEqual(["13 Okt", "15 Okt"])
    expect(labels(render())).toEqual(["13 Okt", "14 Okt", "15 Okt"])
  })
})
