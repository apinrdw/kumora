// The relay's Effect scheduler: Effect's own `MixedScheduler`, yielding through
// a `MessageChannel` message instead of a timer. A message task is never
// clamped the way nested timers are.
import { Scheduler } from "effect"

const channel = new MessageChannel()
// One posted message runs one task, in the order they were posted.
const tasks: Array<() => void> = []
channel.port1.onmessage = () => tasks.shift()?.()

const postTask = (task: () => void) => {
  let cancelled = false
  tasks.push(() => {
    if (!cancelled) task()
  })
  channel.port2.postMessage(undefined)
  return () => {
    cancelled = true
  }
}

export const relayScheduler: Scheduler.Scheduler = new Scheduler.MixedScheduler(
  "async",
  postTask
)
