// How the Major holders panel shows a holder's move against the month
// before: the table's chips and the Every month grid's marks both read it.
import type { Move } from "@/lib/holder-identity"

export const MOVEMENT: Record<
  Move,
  { readonly label: string; readonly text: string; readonly chip: string }
> = {
  new: { label: "New", text: "text-info", chip: "bg-info/15" },
  up: { label: "Up", text: "text-up", chip: "bg-up/15" },
  down: { label: "Down", text: "text-down", chip: "bg-down/15" },
  unchanged: { label: "Unchanged", text: "text-muted-foreground", chip: "" },
  "off list": {
    label: "Off list",
    text: "text-neutral",
    chip: "bg-neutral/15",
  },
}
