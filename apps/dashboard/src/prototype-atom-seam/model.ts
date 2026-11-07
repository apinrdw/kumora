// PROTOTYPE, throwaway: answers "Prototype the atom seam over lib/format.ts in
// the dashboard data table" (apinrdw/kumora#102). Lives on the
// prototype/atom-seam-data-table branch only.
//
// Question: if every lib/format.ts function returns an Effect and React reads
// values only through atoms, how fine should the atoms be, and what does each
// grain cost against today's plain version on a 500-row table?
//
// Assumption: the question is about cost, not looks, so every variant shares
// one table markup and differs only in how a formatted string reaches a cell.
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"

import * as F from "@/lib/format"

// --- The migrated format module: every function returns an Effect. ---------
export const FormatE = {
  idr: (n: number) => Effect.sync(() => F.idr(n)),
  pct: (n: number) => Effect.sync(() => F.pct(n)),
  compactIdr: (n: number) => Effect.sync(() => F.compactIdr(n)),
  shares: (n: number) => Effect.sync(() => F.shares(n)),
  asOf: (iso: string) => Effect.sync(() => F.asOf(iso)),
}

// --- Data ------------------------------------------------------------------
export type Row = {
  id: string
  ticker: string
  last: number
  chg: number
  value: number
  volume: number
  asOf: string
}

export const COLUMNS = [
  "ticker",
  "last",
  "chg",
  "value",
  "volume",
  "asOf",
] as const
export type Col = (typeof COLUMNS)[number]
export type View = Record<Col, string>

export const ROWS = 500

export function makeRows(n = ROWS): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const last = 1000 + ((i * 7919) % 9000)
    return {
      id: `R${i}`,
      ticker: `T${String(i).padStart(3, "0")}`,
      last,
      chg: ((i % 21) - 10) / 3,
      value: last * 1e6 * ((i % 13) + 1),
      volume: 1e5 * ((i % 31) + 1),
      asOf: "2026-11-07T07:45:00Z",
    }
  })
}

let seed = 1
function rand() {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}

/** Moves `share` of the rows (a price tick). Returns new row objects for the moved ones. */
export function tick(rows: ReadonlyArray<Row>, share: number): Row[] {
  return rows.map((r) => {
    if (rand() > share) return r
    const last = Math.max(50, r.last + Math.round((rand() - 0.5) * 50))
    return {
      ...r,
      last,
      chg: r.chg + (rand() - 0.5) / 10,
      value: r.value + last * 1000,
      volume: r.volume + 100,
    }
  })
}

// --- Plain formatting (variant A, today's code) -----------------------------
export function viewPlain(r: Row): View {
  return {
    ticker: r.ticker,
    last: F.idr(r.last),
    chg: F.pct(r.chg),
    value: F.compactIdr(r.value),
    volume: F.shares(r.volume),
    asOf: F.asOf(r.asOf),
  }
}

// --- Effect formatting ------------------------------------------------------
export function cellE(r: Row, c: Col): Effect.Effect<string> {
  switch (c) {
    case "ticker":
      return Effect.succeed(r.ticker)
    case "last":
      return FormatE.idr(r.last)
    case "chg":
      return FormatE.pct(r.chg)
    case "value":
      return FormatE.compactIdr(r.value)
    case "volume":
      return FormatE.shares(r.volume)
    case "asOf":
      return FormatE.asOf(r.asOf)
  }
}

export const viewE = (r: Row): Effect.Effect<View> =>
  Effect.all({
    ticker: cellE(r, "ticker"),
    last: cellE(r, "last"),
    chg: cellE(r, "chg"),
    value: cellE(r, "value"),
    volume: cellE(r, "volume"),
    asOf: cellE(r, "asOf"),
  })

// --- Atoms ------------------------------------------------------------------
// Variants B and C keep one writable atom per row, so a tick touches only the
// moved rows. Variant D keeps the whole array in one atom.
export const rowAtom = Atom.family((_id: string) =>
  Atom.make<Row | undefined>(undefined)
)

/** B: one Effect atom per cell. */
export const cellAtom = Atom.family((key: string) => {
  const [id, col] = key.split("|") as [string, Col]
  return Atom.make((get) => {
    const r = get(rowAtom(id))
    return r ? cellE(r, col) : Effect.succeed("")
  })
})

/** C: one Effect atom per row, formatting the whole row. */
export const rowViewAtom = Atom.family((id: string) =>
  Atom.make((get) => {
    const r = get(rowAtom(id))
    return r ? viewE(r) : Effect.succeed(undefined)
  })
)

/** D: the whole table in one atom. */
export const tableRowsAtom = Atom.make<ReadonlyArray<Row>>([])
export const tableViewAtom = Atom.make((get) =>
  Effect.forEach(get(tableRowsAtom), (r) =>
    Effect.map(viewE(r), (v) => [r.id, v] as const)
  )
)

export const unwrap = AsyncResult.getOrThrow
