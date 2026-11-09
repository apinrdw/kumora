import { IconSearch } from "@tabler/icons-react"
import { searchStockCodes, type StockCode } from "@workspace/client"
import type { ListedCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useId, useMemo, useState } from "react"
import type { KeyboardEvent } from "react"

import { KInput } from "@/components/k/input"

import type { StockCodeList } from "./use-stock-code-list"

// The most matches a search shows.
const SHOWN = 50

const KIND_TAG: Record<ListedCode["kind"], string | undefined> = {
  share: undefined,
  warrant: "Warrant",
  right: "Right",
}

const EMPTY_TEXT: Record<StockCodeList["_tag"], string> = {
  Loading: "Loading codes…",
  Ready: "No code matches.",
  Missing: "The code list arrives when the relay starts.",
}

export type StockCodePickerProps = {
  list: StockCodeList
  onPick: (code: StockCode) => void
  label: string
  /** The list shows while the input has focus; `always` keeps it open (the palette). */
  open?: "focus" | "always"
  shortcut?: string
  placeholder?: string
  className?: string
}

// A combobox over the day's stock codes: type to filter, arrows to move,
// Enter or a click to pick. Shares rank above warrants and rights.
export function StockCodePicker({
  list,
  onPick,
  label,
  open = "focus",
  shortcut,
  placeholder = "Search code or name",
  className,
}: StockCodePickerProps) {
  const listId = useId()
  const [query, setQuery] = useState("")
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  const matches = useMemo(
    () =>
      list._tag === "Ready"
        ? Effect.runSync(searchStockCodes(list.codes, query, SHOWN))
        : [],
    [list, query]
  )
  const expanded = open === "always" || focused
  const activeMatch = matches[Math.min(active, matches.length - 1)]

  const pick = (code: StockCode) => {
    setQuery("")
    setActive(0)
    onPick(code)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((current) =>
        Math.max(0, Math.min(matches.length - 1, current + step))
      )
    } else if (event.key === "Enter" && activeMatch) {
      event.preventDefault()
      pick(activeMatch.code)
      if (open === "focus") event.currentTarget.blur()
    } else if (event.key === "Escape" && open === "focus") {
      setQuery("")
      event.currentTarget.blur()
    }
  }

  return (
    <div className={cn("relative", className)}>
      <KInput
        label={label}
        hideLabel
        icon={IconSearch}
        shortcut={shortcut}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          expanded && activeMatch ? `${listId}-${activeMatch.code}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {expanded && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className={cn(
            "max-h-80 overflow-y-auto rounded-sm border border-border bg-popover py-1 text-[13px]",
            open === "focus" &&
              "shadow-modal absolute inset-x-0 top-full z-20 mt-1"
          )}
        >
          {matches.length === 0 && (
            <div className="px-3 py-1.5 text-muted-foreground">
              {EMPTY_TEXT[list._tag]}
            </div>
          )}
          {matches.map((listed) => {
            const tag = KIND_TAG[listed.kind]
            return (
              <div
                key={listed.code}
                id={`${listId}-${listed.code}`}
                role="option"
                aria-selected={listed === activeMatch}
                className={cn(
                  "flex cursor-pointer items-baseline gap-2 px-3 py-1.5",
                  listed === activeMatch && "bg-elevated"
                )}
                // Before the input's blur closes the list.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(listed.code)}
                // Focus stays in the input; this covers an option that took it.
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (event.key === "Enter") pick(listed.code)
                }}
              >
                <span className="w-24 shrink-0 font-semibold">
                  {listed.code}
                </span>
                <span className="truncate text-muted-foreground">
                  {listed.name}
                </span>
                {tag && (
                  <span className="ml-auto shrink-0 rounded-xs border border-border px-1 text-[11px] text-muted-foreground">
                    {tag}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
