// The isolated content script in the owner's Stockbit and Ajaib tabs (spec
// apinrdw/kumora#138, "Broker connections"). It opens the relay's own sockets
// from the tab's origin, so the tab's session authenticates them, and does
// only what the service worker's port tells it: open, send, close, make a
// request, and report back. It reads none of the page's own subscriptions, so
// the owner can navigate the tab freely.
//
// It stays dependency-free and imports types only: a content script is a
// classic script and can't load a shared chunk.
import type { Feed } from "@workspace/relay"

import type {
  BrokerCommand,
  BrokerEvent,
  Payload,
  TabCommand,
  TabRequest,
} from "../worker/broker.ts"

type Answer = {
  readonly _tag: "answer"
  readonly id: number
  readonly status: number
  readonly body: string
}

const feed: Feed = location.hostname === "stockbit.com" ? "Stockbit" : "Ajaib"

// The page's latest REST request, from the MAIN-world wrapper (page.ts): its
// API base and its exact headers. Ajaib answers 403 without them.
let pageRequest:
  | { readonly base: string; readonly headers: Record<string, string> }
  | undefined
window.addEventListener("message", (event) => {
  const data: unknown = event.data
  if (
    event.source === window &&
    typeof data === "object" &&
    data !== null &&
    "kumoraRelay" in data &&
    data.kumoraRelay === "page-request" &&
    "base" in data &&
    typeof data.base === "string" &&
    "headers" in data &&
    typeof data.headers === "object" &&
    data.headers !== null
  )
    pageRequest = {
      base: data.base,
      headers: data.headers as Record<string, string>,
    }
})

window.postMessage({ kumoraRelay: "ask-page-request" }, location.origin)

const toBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

const wire = (payload: Payload) =>
  "text" in payload
    ? payload.text
    : Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0))

const cookie = (name: string) => {
  for (const pair of document.cookie.split("; ")) {
    const at = pair.indexOf("=")
    if (pair.slice(0, at) === name) return pair.slice(at + 1)
  }
  return ""
}

const answer = async (request: TabRequest): Promise<[number, string]> => {
  switch (request._tag) {
    case "cookie":
      return [200, cookie(request.name)]
    case "fetch": {
      const response = await fetch(request.url, { headers: request.headers })
      return [response.status, await response.text()]
    }
    case "page-fetch": {
      if (pageRequest === undefined) return [0, ""]
      const response = await fetch(new URL(request.path, pageRequest.base), {
        headers: pageRequest.headers,
        credentials: "include",
      })
      return [response.status, await response.text()]
    }
  }
}

const sockets = new Map<string, WebSocket>()
const keyOf = (command: { site: string; connection: string }) =>
  `${command.site}/${command.connection}`

const relay = () => {
  let port: chrome.runtime.Port
  try {
    port = chrome.runtime.connect({ name: feed })
  } catch {
    // The extension was reloaded or removed: this script is orphaned until
    // the tab reloads.
    return
  }
  const post = (event: BrokerEvent | Answer) => {
    try {
      port.postMessage(event)
    } catch {
      // The port closed; onDisconnect reconnects.
    }
  }

  const open = (command: Extract<BrokerCommand, { _tag: "open" }>) => {
    const { site, connection } = command
    const key = keyOf(command)
    const socket = new WebSocket(command.url, [...command.protocols])
    socket.binaryType = "arraybuffer"
    sockets.get(key)?.close()
    sockets.set(key, socket)
    // A replaced or closed socket goes quiet: only the current one reports.
    const current = () => sockets.get(key) === socket
    socket.addEventListener("open", () => {
      if (!current()) return
      for (const payload of command.subscribe) socket.send(wire(payload))
      post({ _tag: "opened", site, connection })
    })
    socket.addEventListener("message", (event) => {
      if (!current()) return
      const payload =
        typeof event.data === "string"
          ? { text: event.data }
          : { base64: toBase64(event.data as ArrayBuffer) }
      post({ _tag: "frame", site, connection, payload })
    })
    socket.addEventListener("close", (event) => {
      if (!current()) return
      sockets.delete(key)
      post({ _tag: "closed", site, connection, code: event.code })
    })
  }

  port.onMessage.addListener((command: TabCommand) => {
    switch (command._tag) {
      case "open":
        return open(command)
      case "send": {
        const socket = sockets.get(keyOf(command))
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(wire(command.payload))
        return
      }
      case "close": {
        const socket = sockets.get(keyOf(command))
        sockets.delete(keyOf(command))
        return socket?.close()
      }
      case "request":
        return void answer(command.request).then(
          ([status, body]) =>
            post({ _tag: "answer", id: command.id, status, body }),
          () => post({ _tag: "answer", id: command.id, status: 0, body: "" })
        )
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
