// The isolated content script in the owner's Ajaib tab (spec
// apinrdw/kumora#138, "Broker connections"). It opens the relay's own sockets
// from the tab's origin, so Ajaib's cookies authenticate them, and does only
// what the service worker's port tells it: open, send, and report back. It
// reads none of the page's own subscriptions, so the owner can navigate the
// tab freely.
//
// It stays dependency-free and imports types only: a content script is a
// classic script and can't load a shared chunk.
import type { Connection, Feed } from "@workspace/relay"

import type { BrokerCommand, BrokerEvent } from "../worker/broker.ts"

const sockets = new Map<Connection, WebSocket>()

const relay = () => {
  let port: chrome.runtime.Port
  try {
    port = chrome.runtime.connect({ name: "Ajaib" satisfies Feed })
  } catch {
    // The extension was reloaded or removed: this script is orphaned until
    // the tab reloads.
    return
  }
  const post = (event: BrokerEvent) => {
    try {
      port.postMessage(event)
    } catch {
      // The port closed; onDisconnect reconnects.
    }
  }

  const open = (command: Extract<BrokerCommand, { _tag: "open" }>) => {
    const { connection } = command
    const socket = new WebSocket(command.url)
    sockets.get(connection)?.close()
    sockets.set(connection, socket)
    // A replaced socket goes quiet: only the current one reports.
    const current = () => sockets.get(connection) === socket
    socket.addEventListener("open", () => {
      if (!current()) return
      for (const text of command.subscribe) socket.send(text)
      post({ _tag: "opened", connection })
    })
    socket.addEventListener("message", (event) => {
      if (current() && typeof event.data === "string")
        post({ _tag: "frame", connection, text: event.data })
    })
    socket.addEventListener("close", (event) => {
      if (!current()) return
      sockets.delete(connection)
      post({ _tag: "closed", connection, code: event.code })
    })
  }

  port.onMessage.addListener((command: BrokerCommand) => {
    if (command._tag === "open") open(command)
    else {
      const socket = sockets.get(command.connection)
      if (socket?.readyState === WebSocket.OPEN) socket.send(command.text)
    }
  })

  // The service worker stopped or restarted: drop the sockets, since it no
  // longer knows them, and connect again, which wakes it.
  port.onDisconnect.addListener(() => {
    const dropped = [...sockets.values()]
    sockets.clear()
    for (const socket of dropped) socket.close()
    relay()
  })
}

relay()
