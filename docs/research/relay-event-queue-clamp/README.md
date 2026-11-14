# Where a frame's time goes inside the relay

Ticket: [Where a frame's time goes inside the relay, from the broker tab to the ingest socket](https://github.com/apinrdw/kumora/issues/229), measured on 2026-11-12.

## Answer

The time goes into the service worker's event queue. One burst can push the relay into a slow state that it stays in until the extension is reloaded.

- `service-worker.ts` handles every broker-tab port message on a single consumer: `Effect.forever(Effect.flatMap(Queue.take(events), handle))`.
- In Effect 4, `Effect.forever` runs `yieldNow` after each iteration (`repos/effect/packages/effect/src/internal/effect.ts`, `forever`). A service worker has no `setImmediate`, so Effect's `MixedScheduler` yields with `setTimeout(0)` (`Scheduler.ts`, `setTimer`).
- While the queue is short, each port message is a fresh browser task. It wakes the consumer at a shallow timer depth, so each yield returns quickly.
- Once a backlog forms, the consumer never waits on an empty queue. Each yield is a timer set from inside the last timer's callback. Chrome clamps nested timers to at least 4 ms after five levels of nesting, so the consumer drains about 250 events a second, whatever the CPU can do.
- In Session 2 the relay takes about 800 frame events a second: roughly 300 Stockbit plus 100 Ajaib frames per connection, times connections A and B (see [How many frames a second each broker socket sends the relay, by channel](https://github.com/apinrdw/kumora/issues/230)). That is above 250, so after any burst or stall the backlog only grows. 250 ÷ 800 ≈ 0.3× real time, close to the 0.2× seen in production on 2026-11-12. Reloading the extension empties the queue and restores the fast state.

## Evidence

Harness: the built extension in Playwright Chromium, a fake Stockbit socket on both connections, and a fake ingest socket. Each frame carries the time it was sent. Files: `throughput.spec.ts` and `throughput.config.ts` next to this note. They are throwaway, and they read lag samples from temporary `[DEBUG-a4f2]` probes in `service-worker.ts`, which are not included here.

The frames were 600 B of opaque bytes, which the relay doesn't parse.

| Load per connection, two connections | Result |
|---|---|
| 200–4,000 f/s, steady | p99 ≈ 255–270 ms (the 250 ms batch). No backlog. |
| 8,000 f/s for 10 s, then 300 f/s (6 runs) | 3 of 6 runs collapsed. The queue grew about 356 events a second, to 22,000. The wait to dequeue reached 90 s, and delivery lag grew about 7 s for every 5 s sent, never recovering. The other 3 runs drained. |
| Same as above, with the consumer changed to `{ disableYield: true }` (4 runs) | 4 of 4 runs green. p99 ≈ 290 ms, the queue peaked at 84, and the relay carried about 5,700 f/s. |

In a collapsed run, the probes showed:

- **Time from the broker socket to the worker's listener** stayed between 1 and 90 ms. The content script, the base64 step and the port to the worker are not the bottleneck.
- **A CPU profile of the worker** over 6 s of the slow phase was **98.7% idle**, with 10,000 events queued. The limit is timer waits, not CPU.

## Same pattern elsewhere

The ingest socket's read and write loops (`target.ts`, `read` and `write`) and `backfill.ts`'s loop use `Effect.forever` too. When they are backlogged they share the same scheduler and the same 4 ms clamp. The 250 ms batch flush (`Effect.repeat` + `Schedule.spaced`) runs on that scheduler as well. During the burst, frames were dequeued on time but still reached the ingest socket 34 s late. That means the stretch after the queue was clamped too, until the change.

## Not measured

- Real Chrome with a hidden broker tab, the real Stockbit page's own load, and Ajaib's four sockets per connection. None of them are needed to explain the collapse, but they could add to it.
- Whether production's trigger on 2026-11-12 was the 09:00 open burst, a garbage-collection pause, or the worker being stopped and restarted.
