import type { InvestorType } from "@workspace/relay"

// An investor type's colour, as the tape, the sweep log and the sweep
// tooltip show it.
export const INVESTOR_TEXT: Record<InvestorType, string> = {
  F: "text-foreign",
  D: "text-domestic",
}
