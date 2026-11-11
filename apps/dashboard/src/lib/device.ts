import { Effect } from "effect"

// Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
const BROWSERS = [
  ["Edge", /Edg(e|A|iOS)?\//],
  ["Opera", /OPR\//],
  ["Firefox", /Firefox\/|FxiOS\//],
  ["Chrome", /Chrome\/|CriOS\//],
  ["Safari", /Safari\//],
] as const

// iPhone and iPad before macOS, Android before Linux: they say both.
const SYSTEMS = [
  ["iPhone", /iPhone/],
  ["iPad", /iPad/],
  ["Android", /Android/],
  ["ChromeOS", /CrOS/],
  ["Windows", /Windows/],
  ["macOS", /Macintosh/],
  ["Linux", /Linux/],
] as const

const first = (
  names: ReadonlyArray<readonly [string, RegExp]>,
  userAgent: string
) => names.find(([, pattern]) => pattern.test(userAgent))?.[0]

/** A session's browser and system in words, such as "Chrome on macOS". */
export const device = (userAgent: string | null | undefined) =>
  Effect.sync(() => {
    if (!userAgent) return "Unknown device"
    const browser = first(BROWSERS, userAgent)
    const system = first(SYSTEMS, userAgent)
    if (browser === undefined) return "Unknown browser"
    return system === undefined ? browser : `${browser} on ${system}`
  })
