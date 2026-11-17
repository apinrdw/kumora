import type { ViewerDown } from "@workspace/relay"
import { Effect } from "effect"

// What a viewer message changes on the tape. The trading-day object sends a
// snapshot when a socket opens and again for every Select: the socket's first
// starts the tape over, and each later one answers a changed Select.
// Decision: that answer is merged into the tape like a delta. Replacing it
// would cut the 10,000 trades the page keeps to the snapshot's 200 newest, and
// an auction match's fold with them. The chart still takes it as a snapshot.
// Counting outstanding Selects broke when changes overlapped or coalesced. See
// apinrdw/kumora#157.
export const tapeChangeOf = (message: ViewerDown, firstOnSocket: boolean) =>
  Effect.sync((): ViewerDown =>
    message._tag !== "Snapshot" || firstOnSocket
      ? message
      : {
          _tag: "Delta",
          at: message.at,
          tape: message.tape,
          candles: message.candles,
        }
  )
