// The Holder map's search (spec apinrdw/kumora#733, story 2): a combobox
// over the stocks, holders and custodians the newest reports list, by code
// or name.
// Type to filter, arrows to move, Enter or a click to pick.
import { IconSearch } from "@tabler/icons-react"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@ui-sdk/react/combobox"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useMemo, useState } from "react"

import { FIELD_HEIGHT, fieldControl } from "@/components/k/input"
import { type FocusMatch, findFoci } from "@/lib/holder-map-search"

import type { FocusListState } from "./use-focus-list"

// The most matches a search shows.
const SHOWN = 50

const EMPTY_TEXT: Record<FocusListState["_tag"], string> = {
  Loading: "Loading stocks, holders and custodians…",
  Ready: "No stock, holder or custodian matches.",
}

const valueOf = (match: FocusMatch) =>
  match.kind === "stock"
    ? match.code
    : match.kind === "holder"
      ? `holder ${match.key}`
      : `custodian ${match.id}`

export type FocusPickerProps = {
  state: FocusListState
  onPick: (match: FocusMatch) => void
  className?: string
}

export function FocusPicker({ state, onPick, className }: FocusPickerProps) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const matches = useMemo(
    () =>
      state._tag === "Ready"
        ? Effect.runSync(findFoci(state.list, query, SHOWN))
        : [],
    [state, query]
  )

  return (
    <Combobox
      value={null}
      onValueChange={(value) => {
        const match = matches.find((each) => valueOf(each) === value)
        if (match === undefined) return
        setQuery("")
        onPick(match)
      }}
      query={query}
      onQueryChange={(next, details) => {
        // Choosing writes the item's label; the search empties instead.
        if (details.reason !== "item-press") setQuery(next)
      }}
      open={open}
      onOpenChange={setOpen}
      filter={false}
      autoHighlight
    >
      <div className={cn("relative flex items-center", className)}>
        <ComboboxLabel className="sr-only">Focus</ComboboxLabel>
        <IconSearch
          aria-hidden
          stroke={1.75}
          className="pointer-events-none absolute left-3 size-4.5 text-muted-foreground"
        />
        <ComboboxInput
          placeholder="Search a stock, holder or custodian"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          className={cn(fieldControl, FIELD_HEIGHT.sm, "pr-3 pl-9")}
        />
      </div>
      <ComboboxContent
        sideOffset={4}
        className="shadow-modal z-20 max-h-[min(20rem,var(--list-height))] w-(--anchor-width) overflow-y-auto rounded-sm border border-border bg-popover py-1 text-[13px] [--list-height:var(--available-height)]"
      >
        <ComboboxEmpty className="px-3 py-1.5 text-muted-foreground">
          {EMPTY_TEXT[state._tag]}
        </ComboboxEmpty>
        <ComboboxList aria-label="Focus">
          {matches.map((match) => (
            <ComboboxItem
              key={valueOf(match)}
              value={valueOf(match)}
              label={match.kind === "stock" ? match.code : match.name}
              className="data-highlighted:bg-elevated flex cursor-pointer items-baseline gap-2 px-3 py-1.5"
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
                    {match.kind === "holder"
                      ? "Holder"
                      : match.broker === undefined
                        ? "Custodian"
                        : `Custodian ${match.broker}`}
                  </span>
                </>
              )}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
