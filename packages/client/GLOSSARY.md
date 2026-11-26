# Client

The browser side of the apps' Effect code: one runtime, and the stores live data reaches rows through. Words from `apps/dashboard/GLOSSARY.md`: **stock code**, **Day state**.

## Language

**Client runtime**:
The `ManagedRuntime` over the client layer, `clientRuntime`. Event handlers and stores run their Effects through it. A store is built by running `makeDayStateStore` in it, and later runs its source with the services it captured there.

**Client layer**:
The services the client runtime provides, `clientLayer`. It does no I/O when built, so importing it during SSR is safe. Today it holds the frame scheduler.

**Day state store**:
The Day state of every stock code on a page, an index under its stock code (`TN.IHSG`), as one map that `useSyncExternalStore` reads. An update replaces only its own code's Day state, and listeners fire at most once per animation frame. It runs its source only while something subscribes.
_Avoid_: quote store, feed store

**Dashboard base path**:
Where the dashboard Worker serves its pages, sockets, GETs and files on its host, `/dashboard` on every Stage, with no trailing slash: `DashboardBasePath` (`src/base-path.ts`). The dashboard's Stage URL ends in it.
_Avoid_: prefix, mount point, basepath (TanStack's option name, set from it)

**Router path**:
A path as the dashboard's router reads it, with its search and fragment: without the dashboard base path, as in `/market-live?day=2026-11-06` or `/stocks/BBCA#daily-holders`. A page's `redirect` search param and an `Unauthorized` error's `redirectTo` are router paths; the router adds the base path when it navigates.
_Avoid_: route, href

**Path on the host**:
A path as the browser and the Worker see it, under the dashboard base path, as in `/dashboard/market-live`. Every path that skips the router (a socket, a recorded-day GET, a logo, a Better Auth URL) is one, built as `${DashboardBasePath}${path}`.
_Avoid_: absolute path, full path

**Source**:
The Stream of Day state updates a Day state store runs: Market Live, or a recorded day replayed to the replay cursor. Tables and rows never know which one feeds them.
_Avoid_: feed (for the Stream)
