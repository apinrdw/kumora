// Market Bubbles' snapshot (spec apinrdw/kumora#427, "Snapshot"): the map as
// a PNG named for its WIB time, with a caption strip of what it shows.
import { Effect } from "effect"

import type { BubbleView, ColourMetric, SizeMetric, TopN } from "@/lib/bubbles"

const WIB = "Asia/Jakarta"

const stamp = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: WIB,
  hourCycle: "h23",
})
const date = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: WIB,
})
const time = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: WIB,
  hourCycle: "h23",
})

const SIZE: Record<SizeMetric, string> = {
  value: "Value",
  volume: "Volume",
  freq: "Frequency",
}
const COLOUR: Record<ColourMetric, string> = {
  delta: "Buy/Sell delta %",
  change: "Price change %",
}
const TOP: Record<`${TopN}`, string> = {
  "100": "Top 100",
  "50": "Top 50",
  all: "All codes",
}

// market-bubbles-20261116-100005.png, for an instant in epoch ms.
export const snapshotName = (at: number) =>
  Effect.sync(() => {
    const part = Object.fromEntries(
      stamp.formatToParts(at).map(({ type, value }) => [type, value])
    )
    return `market-bubbles-${part.year}${part.month}${part.day}-${part.hour}${part.minute}${part.second}.png`
  })

// The caption's parts, the title first: the date and time in WIB, the
// window, the size and colour metrics, and the filter.
export const snapshotCaption = (view: BubbleView, at: number) =>
  Effect.sync((): ReadonlyArray<string> => [
    "Market Bubbles",
    `${date.format(at)} · ${time.format(at)} WIB`,
    `Window ${view.window}`,
    `Size ${SIZE[view.size]}`,
    `Colour ${COLOUR[view.colour]}`,
    view.sector === undefined
      ? TOP[`${view.top}`]
      : `${TOP[`${view.top}`]} · ${view.sector}`,
  ])

// The caption's parts as the lines of its strip, each at most `width` wide
// as `measure` reads a line joined by "  ·  ". A part wider than `width`
// takes a line of its own.
export const captionLines = (
  parts: ReadonlyArray<string>,
  width: number,
  measure: (text: string) => number
) =>
  Effect.sync((): ReadonlyArray<ReadonlyArray<string>> => {
    const lines: Array<Array<string>> = []
    let line: Array<string> = []
    for (const part of parts) {
      const wider = [...line, part]
      if (line.length > 0 && measure(wider.join("  ·  ")) > width) {
        lines.push(line)
        line = [part]
      } else line = wider
    }
    if (line.length > 0) lines.push(line)
    return lines
  })
