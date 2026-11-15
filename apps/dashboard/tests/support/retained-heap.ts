import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

import { Effect } from "effect"

// The heap after a full collection: what is retained, not what is garbage.
export const retainedHeap = Effect.sync(() => {
  setFlagsFromString("--expose-gc")
  const collect = runInNewContext("gc") as () => void
  collect()
  return process.memoryUsage().heapUsed
})
