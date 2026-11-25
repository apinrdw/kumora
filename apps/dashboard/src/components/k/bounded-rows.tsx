import { useHydrated } from "@tanstack/react-router"
import type { ReactNode } from "react"

// The rows of a list of stored rows the server renders. A list as long as the
// parse's caps allow, rendered whole, took more heap than a Worker has in the
// server render alone (apinrdw/kumora#673's review).
//
// Decision: a page renders a list of stored rows through BoundedRows
// (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
export const ROWS_SHOWN = 200

/**
 * `rows`, each as `children` renders it: the first `bound` on the server,
 * every row once the page hydrates.
 */
export function BoundedRows<Row>({
  rows,
  bound = ROWS_SHOWN,
  children,
}: {
  rows: ReadonlyArray<Row>
  bound?: number
  children: (row: Row, index: number) => ReactNode
}) {
  const hydrated = useHydrated()
  return <>{(hydrated ? rows : rows.slice(0, bound)).map(children)}</>
}
