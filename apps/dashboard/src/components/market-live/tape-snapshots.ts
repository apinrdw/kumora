import type { ViewerDown } from "@workspace/relay"

// What a viewer message changes on the tape.
export function tapeChangeOf(
  message: ViewerDown,
  _firstOnSocket: boolean
): ViewerDown {
  return message
}
