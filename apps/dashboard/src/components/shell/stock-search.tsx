import { IconSearch } from "@tabler/icons-react"
import { useLocation, useNavigate } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"

import { KIconButton } from "@/components/k/button"
import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { useStockListOnDemand } from "@/components/stocks/use-stock-list"

// Typing `/` there means the character, not the search.
const isEditable = (target: EventTarget | null) =>
  Effect.sync(
    () =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")
  )

// The Shell header's stock search: the stocks with parsed holdings, loaded
// on the first focus; picking one opens its stock page. `/` outside a text
// field focuses it. From 768px up it sits in the header; below, an icon opens
// it across the header's full width until it loses focus.
export function StockSearch() {
  const [list, load] = useStockListOnDemand()
  const href = useLocation({ select: (location) => location.href })
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  // Asked for by `/` or the phone's icon, until it loses focus. Below 768px
  // it shows only then; it takes focus once it shows.
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  // `/` is the stock search's on every page, Market Live included
  // (apinrdw/kumora#370: "`/` focuses the search from Market Live"); Market
  // Live's own code palette keeps Ctrl/⌘+K.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        Effect.runSync(isEditable(event.target))
      )
        return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <>
      <div
        className={cn(
          "md:block md:w-64",
          open
            ? "max-md:bg-canvas max-md:absolute max-md:inset-0 max-md:z-10 max-md:flex max-md:items-center max-md:px-4"
            : "hidden"
        )}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }}
      >
        <StockCodePicker
          list={list}
          label="Open a stock"
          placeholder="Search stocks"
          shortcut="/"
          className="w-full"
          inputRef={input}
          onFocus={() => load(href)}
          onPick={(code) => {
            input.current?.blur()
            void navigate({ to: "/stocks/$code", params: { code } })
          }}
        />
      </div>
      {!open && (
        <KIconButton
          icon={IconSearch}
          label="Search stocks"
          tooltip={false}
          className="md:hidden"
          onClick={() => setOpen(true)}
        />
      )}
    </>
  )
}
