import { Effect } from "effect"

import type { Lang } from "./copy"

const LOCALE = { en: "en-US", id: "id-ID" } as const satisfies Record<
  Lang,
  string
>

const WIB = "Asia/Jakarta"

// "09:01:48" in WIB.
export const wibTime = Effect.fnUntraced(function* (epochMs: number) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: WIB,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(epochMs)
})

// "14.45 WIB", the dashboard's as-of shape.
export const wibClock = Effect.fnUntraced(function* (epochMs: number) {
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: WIB,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(epochMs)
  return `${hm.replace(":", ".")} WIB`
})

export const count = Effect.fnUntraced(function* (n: number, lang: Lang) {
  return new Intl.NumberFormat(LOCALE[lang]).format(n)
})

// A signed whole number: "+22,328", "−7,445".
export const signed = Effect.fnUntraced(function* (n: number, lang: Lang) {
  const body = yield* count(Math.abs(n), lang)
  return n > 0 ? `+${body}` : n < 0 ? `−${body}` : body
})

// Rupiah in billions: "Rp1.1 B" in English, "Rp1,1 M" (miliar) in Indonesian.
export const rupiahBillions = Effect.fnUntraced(function* (
  rupiah: number,
  lang: Lang
) {
  const billions = new Intl.NumberFormat(LOCALE[lang], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rupiah / 1e9)
  return `Rp${billions} ${lang === "id" ? "M" : "B"}`
})

// The queue number as the ticket prints it: "A-0127".
export const queueNumber = Effect.fnUntraced(function* (n: number) {
  return `A-${String(n).padStart(4, "0")}`
})
