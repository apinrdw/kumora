import { cn } from "@workspace/ui/lib/utils"
import { useState } from "react"
import type { ReactNode } from "react"

import { kFocus } from "./styles"

// The rows of a list of stored rows a page renders at first. A list as long
// as the parse's caps allow, rendered whole, took more heap than a Worker
// has in the server render alone (apinrdw/kumora#673's review).
//
// Decision: a page renders a list of stored rows through BoundedRows
// (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
export const ROWS_SHOWN = 200

/**
 * `rows`' first `step`, each as `children` renders it, then a button that
 * shows `step` more, placed by `more` in the list's own row element. The
 * rows shown start over when the component's `key` changes.
 */
export function BoundedRows<Row>({
  rows,
  step = ROWS_SHOWN,
  children,
  more,
}: {
  rows: ReadonlyArray<Row>
  step?: number
  children: (row: Row, index: number) => ReactNode
  more: (control: ReactNode) => ReactNode
}) {
  const [shown, setShown] = useState(step)
  const hidden = rows.length - shown
  return (
    <>
      {rows.slice(0, shown).map(children)}
      {hidden > 0 &&
        more(
          <span data-more-rows className="text-[12px] text-muted-foreground">
            {shown} of {rows.length} shown ·{" "}
            <button
              type="button"
              onClick={() => setShown(shown + step)}
              className={cn("text-info rounded-xs font-medium", kFocus)}
            >
              Show {Math.min(step, hidden)} more
            </button>
          </span>
        )}
    </>
  )
}
