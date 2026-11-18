import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

import { Effect } from "effect"

setFlagsFromString("--expose-gc")
const collect = runInNewContext("gc") as () => void

// The heap after a full collection: what is retained, not what is garbage.
export const retainedHeap = Effect.sync(() => {
  collect()
  return process.memoryUsage().heapUsed
})

// The heap and every ArrayBuffer's bytes after a full collection. A stored
// blob's bytes sit outside the heap, so only this counts them. V8 frees a
// dead buffer's bytes after its collection ends, so a second one waits.
export const retainedBytes = () => {
  collect()
  collect()
  const { heapUsed, arrayBuffers } = process.memoryUsage()
  return heapUsed + arrayBuffers
}
