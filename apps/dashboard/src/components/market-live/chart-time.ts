// What both Market Live charts share (chart-canvas.tsx, footprint-canvas.tsx):
// WIB time labels and the price scale's width. Both modules load only in the
// browser.
import { TickMarkType, type Time, type UTCTimestamp } from "lightweight-charts"

// Decision: both charts' price scales are at least this wide, so their plots
// share one width and a minute sits at the same x in each (spec
// apinrdw/kumora#263, "Layout, settings, indices and phone").
export const CHART_SCALE_WIDTH = 72

const WIB = "Asia/Jakarta"
const wibClock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: WIB,
})
const wibDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: WIB,
})
const wibYear = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  timeZone: WIB,
})

// The data is in UTC seconds; every label reads WIB, 24-hour. Lightweight
// Charts calls these two back, so they are plain.
export const crosshairTime = (time: Time) => {
  const date = new Date((time as UTCTimestamp) * 1000)
  return `${wibDate.format(date)}, ${wibClock.format(date)} WIB`
}
export const tickMark = (time: Time, type: TickMarkType) => {
  const date = new Date((time as UTCTimestamp) * 1000)
  return type === TickMarkType.Year
    ? wibYear.format(date)
    : type === TickMarkType.Month || type === TickMarkType.DayOfMonth
      ? wibDate.format(date)
      : wibClock.format(date)
}
