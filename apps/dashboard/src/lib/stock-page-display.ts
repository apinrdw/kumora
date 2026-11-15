// How the stock page's two holdings views write months and shares, and
// colour KSEI investor types: the Shareholders composition panel and the
// Holding composition chart share them.
import { Effect } from "effect"

import type { KseiType } from "@/domain/holdings"

import { plain } from "./format.ts"

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** `2026-10-30` or `2026-10` → `Oct 2026` */
export const monthLabel = (date: string) =>
  Effect.succeed(`${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`)

/** 0.12345 → `12.35%` */
export const percent = (share: number) =>
  Effect.map(plain(share * 100, 2), (text) => `${text}%`)

export const TYPE_COLOR: Record<KseiType, string> = {
  ID: "var(--investor-id)",
  CP: "var(--investor-cp)",
  MF: "var(--investor-mf)",
  IB: "var(--investor-ib)",
  IS: "var(--investor-is)",
  SC: "var(--investor-sc)",
  PF: "var(--investor-pf)",
  FD: "var(--investor-fd)",
  OT: "var(--investor-ot)",
}
