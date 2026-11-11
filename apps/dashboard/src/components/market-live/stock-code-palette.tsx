import type { StockCode } from "@workspace/client"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Effect } from "effect"
import { useEffect, useState } from "react"

import { StockCodePicker } from "./stock-code-picker"
import type { StockCodeList } from "./use-stock-code-list"

// Typing `/` there means the character, not the palette.
const isEditable = (target: EventTarget | null) =>
  Effect.sync(
    () =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")
  )

// The keyboard palette: `/` anywhere outside a text field, or Ctrl/⌘+K
// anywhere, opens a search over the day's codes, focused (the dialog focuses
// its first field); picking one selects it.
export function StockCodePalette({
  list,
  onPick,
}: {
  list: StockCodeList
  onPick: (code: StockCode) => void
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandK =
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k"
      const slash =
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !Effect.runSync(isEditable(event.target))
      if (!commandK && !slash) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-24 translate-y-0 sm:max-w-md">
        <DialogTitle>Go to code</DialogTitle>
        <StockCodePicker
          list={list}
          label="Go to code"
          open="always"
          onPick={(code) => {
            setOpen(false)
            onPick(code)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
