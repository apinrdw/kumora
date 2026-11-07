# Client

The browser side of the apps' Effect code: one runtime, and the stores live data reaches rows through. Words from `apps/dashboard/GLOSSARY.md`: **stock code**, **Day state**.

## Language

**Client runtime**:
The `ManagedRuntime` over the client layer, `clientRuntime`. Event handlers and stores run their Effects through it.

**Client layer**:
The services the client runtime provides, `clientLayer`. It does no I/O when built, so importing it during SSR is safe. Today it holds the frame scheduler.

**Day state store**:
The Day state of every stock code (and every index, by index code) on a page, as one map that `useSyncExternalStore` reads. An update replaces only its own code's Day state, and listeners fire at most once per animation frame. It runs its source only while something subscribes.
_Avoid_: quote store, feed store

**Source**:
The Stream of Day state updates a Day state store runs: Market Live, or a recorded day replayed to the replay cursor. Tables and rows never know which one feeds them.
_Avoid_: feed (for the Stream)
