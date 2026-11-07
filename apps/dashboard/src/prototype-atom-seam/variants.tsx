// PROTOTYPE, throwaway (apinrdw/kumora#102). See model.ts for the question.
import { useAtomValue, useAtomSet, RegistryContext } from "@effect/atom-react"
import { Effect } from "effect"
import { memo, useContext, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { AtomRegistry } from "effect/reactivity"

import {
  COLUMNS,
  cellAtom,
  cellE,
  rowAtom,
  rowViewAtom,
  tableRowsAtom,
  tableViewAtom,
  unwrap,
  viewPlain,
} from "./model"
import type { Col, Row, View } from "./model"

const RIGHT = new Set<Col>(["last", "chg", "value", "volume", "asOf"])

function Table({ children }: { children: ReactNode }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-[13px] leading-[18px]">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th
              key={c}
              className={`h-9 border-b border-border px-3 text-xs font-[450] text-muted-foreground ${RIGHT.has(c) ? "text-right" : "text-left"}`}
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

function Td({ c, children }: { c: Col; children: ReactNode }) {
  return (
    <td
      className={`h-9 border-b border-border px-3 ${RIGHT.has(c) ? "num text-right" : "text-left"}`}
    >
      {children}
    </td>
  )
}

function ViewRow({ v }: { v: View }) {
  return (
    <tr>
      {COLUMNS.map((c) => (
        <Td key={c} c={c}>
          {v[c]}
        </Td>
      ))}
    </tr>
  )
}

/** The variants take rows as props, like KDataTable does today. */
export type VariantProps = { rows: ReadonlyArray<Row> }

// A: today's code. Plain functions called in render.
export function VariantA({ rows }: VariantProps) {
  return (
    <Table>
      {rows.map((r) => (
        <ViewRow key={r.id} v={viewPlain(r)} />
      ))}
    </Table>
  )
}

// E: reference only, excluded by the map's decision. Effect.runSync in render.
export function VariantE({ rows }: VariantProps) {
  return (
    <Table>
      {rows.map((r) => (
        <tr key={r.id}>
          {COLUMNS.map((c) => (
            <Td key={c} c={c}>
              {Effect.runSync(cellE(r, c))}
            </Td>
          ))}
        </tr>
      ))}
    </Table>
  )
}

/** Writes changed rows into their per-row atoms before paint. */
function useSyncRowAtoms(rows: ReadonlyArray<Row>) {
  const registry = useContext(RegistryContext)
  const prev = useRef<ReadonlyArray<Row>>([])
  // Writing during render would warn, so write in a layout effect, as a real
  // feed would write from outside React.
  useLayoutEffect(() => {
    for (let i = 0; i < rows.length; i++) {
      if (prev.current[i] !== rows[i])
        registry.set(rowAtom(rows[i].id), rows[i])
    }
    prev.current = rows
  }, [rows, registry])
  // First render: seed synchronously so the first paint has values (and SSR works).
  useState(() => seed(registry, rows))
}

function seed(registry: AtomRegistry.AtomRegistry, rows: ReadonlyArray<Row>) {
  for (const r of rows) registry.set(rowAtom(r.id), r)
}

// B: one Effect atom per cell, 3,000 atoms for 500 rows.
function CellB({ id, c }: { id: string; c: Col }) {
  return <Td c={c}>{useAtomValue(cellAtom(`${id}|${c}`), unwrap)}</Td>
}
function RowB({ id }: { id: string }) {
  return (
    <tr>
      {COLUMNS.map((c) => (
        <CellB key={c} id={id} c={c} />
      ))}
    </tr>
  )
}
export function VariantB({ rows }: VariantProps) {
  useSyncRowAtoms(rows)
  return (
    <Table>
      {rows.map((r) => (
        <RowB key={r.id} id={r.id} />
      ))}
    </Table>
  )
}

// C: one Effect atom per row.
function RowC({ id }: { id: string }) {
  const v = useAtomValue(rowViewAtom(id), unwrap)
  return v ? <ViewRow v={v} /> : null
}
export function VariantC({ rows }: VariantProps) {
  useSyncRowAtoms(rows)
  return (
    <Table>
      {rows.map((r) => (
        <RowC key={r.id} id={r.id} />
      ))}
    </Table>
  )
}

// F: C with memoized rows, so a tick re-renders only the rows whose atom moved.
const RowF = memo(RowC)
export function VariantF({ rows }: VariantProps) {
  useSyncRowAtoms(rows)
  return (
    <Table>
      {rows.map((r) => (
        <RowF key={r.id} id={r.id} />
      ))}
    </Table>
  )
}

// G: A with memoized rows keyed on the row object, the plain equivalent of F.
const RowG = memo(function RowG({ r }: { r: Row }) {
  return <ViewRow v={viewPlain(r)} />
})
export function VariantG({ rows }: VariantProps) {
  return (
    <Table>
      {rows.map((r) => (
        <RowG key={r.id} r={r} />
      ))}
    </Table>
  )
}

// D: one Effect atom for the whole table.
export function VariantD({ rows }: VariantProps) {
  const registry = useContext(RegistryContext)
  const set = useAtomSet(tableRowsAtom)
  useState(() => registry.set(tableRowsAtom, rows))
  useLayoutEffect(() => set(rows), [rows, set])
  const view = useAtomValue(tableViewAtom, unwrap)
  return (
    <Table>
      {view.map(([id, v]) => (
        <ViewRow key={id} v={v} />
      ))}
    </Table>
  )
}

export const VARIANTS = {
  A: { name: "Plain (today)", C: VariantA },
  B: { name: "Atom per cell", C: VariantB },
  C: { name: "Atom per row", C: VariantC },
  D: { name: "One table atom", C: VariantD },
  E: { name: "runSync in render (excluded)", C: VariantE },
  F: { name: "Atom per row, memo rows", C: VariantF },
  G: { name: "Plain, memo rows", C: VariantG },
} as const
export type VariantKey = keyof typeof VARIANTS
