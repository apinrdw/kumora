// The Holder map's search (spec apinrdw/kumora#733, story 2): a combobox
// over the stocks and holders the newest reports list, by code or name.
// Type to filter, arrows to move, Enter or a click to pick.
import { IconSearch } from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useId, useMemo, useState } from "react"

import { KInput } from "@/components/k/input"
import { comboboxKeyDown } from "@/components/market-live/stock-code-picker"
import { type FocusMatch, findFoci } from "@/lib/holder-map-search"

import type { FocusListState } from "./use-focus-list"

// The most matches a search shows.
const SHOWN = 50

const EMPTY_TEXT: Record<FocusListState["_tag"], string> = {
  Loading: "Loading stocks and holders…",
  Ready: "No stock or holder matches.",
}

export type FocusPickerProps = {
  state: FocusListState
  onPick: (match: FocusMatch) => void
  className?: string
}

export function FocusPicker({ state, onPick, className }: FocusPickerProps) {
  const listId = useId()
  const [query, setQuery] = useState("")
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  const matches = useMemo(
    () =>
      state._tag === "Ready"
        ? Effect.runSync(findFoci(state.list, query, SHOWN))
        : [],
    [state, query]
  )
  const at = Math.min(active, matches.length - 1)
  const activeMatch = matches[at]

  const pick = (match: FocusMatch) => {
    setQuery("")
    setActive(0)
    onPick(match)
  }

  return (
    <div className={cn("relative", className)}>
      <KInput
        label="Focus"
        hideLabel
        icon={IconSearch}
        placeholder="Search a stock or holder"
        role="combobox"
        aria-expanded={focused}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          focused && activeMatch ? `${listId}-${at}` : undefined
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
        onKeyDown={(event) =>
          comboboxKeyDown(event, {
            count: matches.length,
            setActive,
            pick: activeMatch && (() => pick(activeMatch)),
            clear: () => setQuery(""),
            closes: true,
          })
        }
      />
      {focused && (
        <div
          id={listId}
          role="listbox"
          aria-label="Focus"
          className="shadow-modal absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-sm border border-border bg-popover py-1 text-[13px]"
        >
          {matches.length === 0 && (
            <div className="px-3 py-1.5 text-muted-foreground">
              {EMPTY_TEXT[state._tag]}
            </div>
          )}
          {matches.map((match, index) => (
            <div
              key={match.kind === "stock" ? match.code : `holder ${match.key}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === at}
              className={cn(
                "flex cursor-pointer items-baseline gap-2 px-3 py-1.5",
                index === at && "bg-elevated"
              )}
              // Before the input's blur closes the list.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(match)}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Enter") pick(match)
              }}
            >
              {match.kind === "stock" ? (
                <>
                  <span className="w-16 shrink-0 font-semibold">
                    {match.code}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {match.name}
                  </span>
                </>
              ) : (
                <>
                  <span className="truncate">{match.name}</span>
                  <span className="ml-auto shrink-0 rounded-xs border border-border px-1 text-[11px] text-muted-foreground">
                    Holder
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
