// @vitest-environment happy-dom
// PROTOTYPE, throwaway (apinrdw/kumora#102). Run:
//   pnpm --filter dashboard exec vitest run src/prototype-atom-seam
// Prints mount and tick medians per variant. Not a regression test.
import { RegistryContext } from "@effect/atom-react"
import { AtomRegistry } from "effect/reactivity"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { expect, test } from "vitest"

import { makeRows, tick } from "./model"
import type { Row } from "./model"
import { VARIANTS } from "./variants"
import type { VariantKey } from "./variants"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ROUNDS = 5
const TICKS = 15

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function once(key: VariantKey) {
  const { C } = VARIANTS[key]
  const registry = AtomRegistry.make()
  const el = document.createElement("div")
  document.body.append(el)
  const root = createRoot(el)
  let rows: Row[] = makeRows()
  const render = () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <C rows={rows} />
      </RegistryContext.Provider>
    )

  let t = performance.now()
  act(render)
  const mount = performance.now() - t
  const firstCell = el.querySelector("tbody td:nth-child(2)")?.textContent

  const timeTicks = (share: number) => {
    const out: number[] = []
    for (let i = 0; i < TICKS; i++) {
      rows = tick(rows, share)
      t = performance.now()
      act(render)
      out.push(performance.now() - t)
    }
    return median(out)
  }
  const tick10 = timeTicks(0.1)
  const tick100 = timeTicks(1)

  // The DOM must match the plain formatting after the ticks.
  const lastRow = rows[rows.length - 1]
  const lastCell = el.querySelector(
    "tbody tr:last-child td:nth-child(2)"
  )?.textContent
  const nodes = registry.getNodes().size
  act(() => root.unmount())
  el.remove()
  registry.dispose()
  return { mount, tick10, tick100, nodes, firstCell, lastCell, lastRow }
}

function ssr(key: VariantKey) {
  const { C } = VARIANTS[key]
  const registry = AtomRegistry.make()
  const t = performance.now()
  const html = renderToString(
    <RegistryContext.Provider value={registry}>
      <C rows={makeRows()} />
    </RegistryContext.Provider>
  )
  const ms = performance.now() - t
  registry.dispose()
  return { ms, hasValue: html.includes("Rp") }
}

test("atom seam cost per variant, 500 rows x 6 columns", () => {
  const keys = Object.keys(VARIANTS) as VariantKey[]
  // Warm up every variant once so JIT does not favour whichever runs last.
  for (const k of keys) once(k)
  const table: Record<string, unknown>[] = []
  for (const k of keys) {
    const runs = Array.from({ length: ROUNDS }, () => once(k))
    const s = Array.from({ length: ROUNDS }, () => ssr(k))
    const r = runs[0]
    expect(r.firstCell).toMatch(/^Rp/)
    expect(r.lastCell).toBe(
      "Rp" + new Intl.NumberFormat("id-ID").format(r.lastRow.last)
    )
    expect(s[0].hasValue).toBe(true)
    table.push({
      variant: `${k} ${VARIANTS[k].name}`,
      "mount ms": median(runs.map((x) => x.mount)).toFixed(1),
      "tick 10% ms": median(runs.map((x) => x.tick10)).toFixed(1),
      "tick 100% ms": median(runs.map((x) => x.tick100)).toFixed(1),
      "ssr ms": median(s.map((x) => x.ms)).toFixed(1),
      "atom nodes": r.nodes,
    })
  }
  console.table(table)
}, 120_000)
