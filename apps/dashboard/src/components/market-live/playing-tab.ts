import { clientRuntime } from "@workspace/client"
import type { WibDate } from "@workspace/relay"
import { Clock, Effect, Option, Schema } from "effect"
import { useEffect, useState } from "react"

// One open Market Live tab as the others know it: when the member last
// focused it (0 if not since it opened) and when it opened.
const Peer = Schema.Struct({
  id: Schema.String,
  focusedAt: Schema.Number,
  joinedAt: Schema.Number,
})
type Peer = typeof Peer.Type

// What the tabs say over the channel. A tab says Hello as it opens and every
// other tab gives an Answer, so it learns which is the Playing tab before an
// alert arrives; a tab whose stamps changed says Here; a closing tab says Bye.
// An Answer names the tab it answers (`to`): the channel carries it to every
// tab.
const TabMessage = Schema.Union([
  Schema.TaggedStruct("Hello", { peer: Peer }),
  Schema.TaggedStruct("Answer", { peer: Peer, to: Schema.String }),
  Schema.TaggedStruct("Here", { peer: Peer }),
  Schema.TaggedStruct("Bye", { id: Schema.String }),
])
export type TabMessage = typeof TabMessage.Type

type TabChannel = {
  readonly post: (message: TabMessage) => void
  readonly close: () => void
}

// Opens this tab's end of the channel the Market Live tabs share: a
// BroadcastChannel on the page (broadcastTabChannel), a shared fake in tests.
export type OpenTabChannel = (
  receive: (message: TabMessage) => void
) => Effect.Effect<TabChannel>

// Each browser's one channel for its Market Live tabs.
const CHANNEL = "kumora:market-live:playing-tab"

const decodeTabMessage = Schema.decodeUnknownOption(TabMessage)

// Another tab may run an older or newer build: a message this build can't
// read is dropped.
const broadcastTabChannel: OpenTabChannel = (receive) =>
  Effect.sync(() => {
    const channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (event) => {
      const message = decodeTabMessage(event.data)
      if (Option.isSome(message)) receive(message.value)
    }
    return {
      post: (message) => channel.postMessage(message),
      close: () => channel.close(),
    }
  })

// Whether `a` rather than `b` is the Playing tab: the one focused last, and
// between tabs not focused since they opened, the one open longest, so a tab
// opening in the background leaves the Playing tab as it is.
const outranks = (a: Peer, b: Peer) =>
  Effect.sync(() =>
    a.focusedAt !== b.focusedAt
      ? a.focusedAt > b.focusedAt
      : a.joinedAt !== b.joinedAt
        ? a.joinedAt < b.joinedAt
        : a.id < b.id
  )

// Decision: every tab keeps the same list of open tabs and works out the
// Playing tab from it, so no tab hands over and a closing tab only says Bye
// (spec apinrdw/kumora#510, "One tab plays"). A tab that closes without a
// word (a crash) stays the Playing tab in the others' lists until another tab
// is focused.
//
// This tab's claim on playing the Sweep alerts: it is the Playing tab while
// it is the Market Live tab focused last among those open in the browser. A
// tab alone is, focused or not.
export const makePlayingTab = (open: OpenTabChannel) =>
  Effect.sync(() => {
    const id = crypto.randomUUID()
    const peers = new Map<string, Peer>()
    let self: Peer | undefined
    let channel: TabChannel | undefined

    const receive = (message: TabMessage) => {
      if (message._tag === "Bye") {
        peers.delete(message.id)
        return
      }
      const { peer } = message
      peers.set(peer.id, peer)
      if (self === undefined) return
      if (message._tag === "Hello")
        channel?.post({ _tag: "Answer", peer: self, to: peer.id })
      // This tab opened after every tab that answers it, and if it opened
      // focused, it was focused after them too, though clocks tie.
      if (message._tag === "Answer" && message.to === id) {
        const later = {
          ...self,
          joinedAt: Math.max(self.joinedAt, peer.joinedAt + 1),
          focusedAt:
            self.focusedAt === 0
              ? 0
              : Math.max(self.focusedAt, peer.focusedAt + 1),
        }
        if (
          later.joinedAt === self.joinedAt &&
          later.focusedAt === self.focusedAt
        )
          return
        self = later
        channel?.post({ _tag: "Here", peer: self })
      }
    }

    // A focus stamp later than any this tab knows, though clocks tie.
    const focusStamp = Effect.map(Clock.currentTimeMillis, (now) =>
      Math.max(
        now,
        ...[...peers.values()].map(({ focusedAt }) => focusedAt + 1)
      )
    )

    return {
      // Opens the channel and says Hello: the page opening or coming back.
      // Until the Answers arrive, a moment before its socket can bring an
      // alert, the tab knows no other and is the Playing tab.
      join: Effect.fnUntraced(function* (focused: boolean) {
        if (channel !== undefined) return
        const joinedAt = yield* Clock.currentTimeMillis
        self = { id, joinedAt, focusedAt: focused ? joinedAt : 0 }
        channel = yield* open(receive)
        channel.post({ _tag: "Hello", peer: self })
      }),
      // The member focused this tab: it becomes the Playing tab.
      focus: Effect.gen(function* () {
        if (self === undefined || channel === undefined) return
        self = { ...self, focusedAt: yield* focusStamp }
        channel.post({ _tag: "Here", peer: self })
      }),
      // Says Bye and closes the channel: the page closing or going away.
      leave: Effect.sync(() => {
        channel?.post({ _tag: "Bye", id })
        channel?.close()
        channel = undefined
        self = undefined
        peers.clear()
      }),
      holds: Effect.gen(function* () {
        if (self === undefined) return false
        for (const peer of peers.values())
          if (!(yield* outranks(self, peer))) return false
        return true
      }),
    }
  })

// The live page's claim on being the Playing tab, open while the page shows:
// it joins as the page opens or comes back from the back-forward cache, and
// leaves on `pagehide`, which a closing tab fires though React never unmounts
// it. A recorded day never plays, so its tab stays out and never takes over
// from a live one.
export const usePlayingTab = (day: WibDate | undefined) => {
  const [tab] = useState(() =>
    Effect.runSync(makePlayingTab(broadcastTabChannel))
  )
  useEffect(() => {
    if (day !== undefined) return
    const join = () => clientRuntime.runSync(tab.join(document.hasFocus()))
    const leave = () => clientRuntime.runSync(tab.leave)
    const focus = () => clientRuntime.runSync(tab.focus)
    join()
    window.addEventListener("focus", focus)
    window.addEventListener("pageshow", join)
    window.addEventListener("pagehide", leave)
    return () => {
      window.removeEventListener("focus", focus)
      window.removeEventListener("pageshow", join)
      window.removeEventListener("pagehide", leave)
      leave()
    }
  }, [day, tab])
  return tab
}
