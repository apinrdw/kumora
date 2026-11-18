// How an archive admin card sets out what a run could not do: a warning
// panel of notes, each a bold count and a sentence over its list.
import { IconAlertTriangle } from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

/** A warning panel holding one or more `Note`s. */
export function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="border-warning/40 bg-warning/10 flex gap-3 rounded-sm border px-4 py-3 text-sm leading-5">
      <IconAlertTriangle
        aria-hidden
        className="text-warning mt-0.5 size-4 shrink-0"
        stroke={1.75}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>
    </div>
  )
}

/** One note: `lead` in bold, then the sentence, then its list. */
export function Note({
  lead,
  children,
}: {
  lead: ReactNode
  children: ReactNode
}) {
  return (
    <div className="min-w-0">
      <b className="font-semibold">{lead}</b> {children}
    </div>
  )
}

/**
 * The rows under a note, named `label`. `data` sets them in the data face,
 * for file names and months.
 */
export function NoteList({
  label,
  data = false,
  children,
}: {
  label: string
  data?: boolean
  children: ReactNode
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "border-strong mt-2 flex flex-col border-l-2 pl-3",
        data ? "font-data text-xs leading-5" : "text-[13px] leading-5"
      )}
    >
      {children}
    </ul>
  )
}

/** A row of a `NoteList`. */
export function NoteItem({ children }: { children: ReactNode }) {
  return <li className="py-0.5 [overflow-wrap:anywhere]">{children}</li>
}
