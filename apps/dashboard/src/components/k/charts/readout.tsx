import type { ReactNode } from "react"

export type ReadoutRow = { label: string; value: string; swatch?: string }

/** Floating crosshair readout shared by the Recharts charts. */
export function ChartReadout({
  title,
  rows,
}: {
  title: ReactNode
  rows: ReadonlyArray<ReadoutRow>
}) {
  return (
    <div className="bg-elevated grid min-w-36 gap-1 rounded-xs border border-border px-3 py-2 text-xs leading-[18px] text-foreground shadow-popover">
      <div className="num font-medium">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3">
          <span className="text-secondary-text inline-flex items-center gap-1.5">
            {r.swatch && (
              <i
                aria-hidden
                className="inline-block size-2 rounded-[2px]"
                style={{ background: r.swatch }}
              />
            )}
            {r.label}
          </span>
          <span className="num">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Recharts tooltip `content` that shows the readout for the hovered point,
 * matched by its unique label, and nothing outside the plot.
 * Decision: plain, not an Effect: it builds the render callback recharts
 * calls, which CODING_STANDARDS.md exempts.
 */
export function pointReadout<P extends { label: string }>(
  data: ReadonlyArray<P>,
  rows: (p: P) => ReadonlyArray<ReadoutRow>
) {
  return ({ active, label }: { active?: boolean; label?: unknown }) => {
    const p = active ? data.find((d) => d.label === label) : undefined
    return p ? <ChartReadout title={p.label} rows={rows(p)} /> : null
  }
}
