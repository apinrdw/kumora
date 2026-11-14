// The isolated content script in the owner's Stockbit and Ajaib tabs (spec
// apinrdw/kumora#138, "Broker connections"). It opens the relay's own sockets
// from the tab's origin, so the tab's session authenticates them, and does
// only what the service worker's port tells it: open, send, close, make a
// request, and report back. It reads none of the page's own subscriptions, so
// the owner can navigate the tab freely.
//
// It stays dependency-free and imports types only: a content script is a
// classic script and can't load a shared chunk.
import type { Connection, Feed } from "@workspace/relay"

import type {
  BrokerCommand,
  BrokerEvent,
  PageEvent,
  Payload,
  SiteName,
  TabCommand,
  TabRequest,
} from "../worker/broker.ts"

type Answer = {
  readonly _tag: "answer"
  readonly id: number
  readonly status: number
  readonly body: string
  readonly challenge?: boolean
}

// Decision: before the page made a REST call of its own, its API base is
// taken as the PIN check's host, ht2.ajaib.co.id/api/; unconfirmed until the
// owner checks a page call in DevTools.
const AJAIB_API_BASE = "https://ht2.ajaib.co.id/api/"

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

// Ajaib's lock screen (spec apinrdw/kumora#244, "The extension: Ajaib
// keep-alive and the PIN lock"): page.ts reports it and the page's PIN check,
// which go to the worker over the current port, and answers `type-pin`.
let forward: (event: PageEvent) => void = () => {}
const typing = new Map<number, (typed: boolean) => void>()
let nextTyping = 0

const fromPage = (event: MessageEvent): Record<string, unknown> | undefined => {
  const data: unknown = event.data
  if (event.source !== window || typeof data !== "object" || data === null)
    return undefined
  return data as Record<string, unknown>
}

const lockMessages: Record<string, (data: Record<string, unknown>) => void> = {
  lock: ({ locked }) => {
    if (typeof locked === "boolean") forward({ _tag: "lock", locked })
  },
  "pin-validated": ({ status }) => {
    if (typeof status === "number") forward({ _tag: "pin-validated", status })
  },
  "pin-typed": ({ id, typed }) => {
    if (typeof id !== "number") return
    typing.get(id)?.(typed === true)
    typing.delete(id)
  },
}

window.addEventListener("message", (event) => {
  const data = fromPage(event)
  if (typeof data?.kumoraRelay === "string")
    lockMessages[data.kumoraRelay]?.(data)
})

type LockRequest = Extract<TabRequest, { _tag: "activity" | "type-pin" }>

// Asks page.ts to type the PIN: whether it found the lock screen's boxes.
const typePin = (pin: string) =>
  new Promise<boolean>((resolve) => {
    const id = nextTyping++
    typing.set(id, resolve)
    window.postMessage({ kumoraRelay: "type-pin", id, pin }, location.origin)
  })

const lockAnswer = async (request: LockRequest): Promise<[number, string]> => {
  if (request._tag === "activity") {
    window.postMessage({ kumoraRelay: "activity" }, location.origin)
    return [200, ""]
  }
  return (await typePin(request.pin)) ? [200, ""] : [404, ""]
}

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

// A REST answer's status and body, and whether Cloudflare marked it as a
// challenge (readable only when the API exposes the header).
const read = async (
  response: Response
): Promise<[number, string, boolean?]> => [
  response.status,
  await response.text(),
  response.headers.get("cf-mitigated") === "challenge" || undefined,
]

const answer = async (
  request: Exclude<TabRequest, LockRequest>
): Promise<[number, string, boolean?]> => {
  switch (request._tag) {
    case "cookie":
      return [200, cookie(request.name)]
    case "fetch": {
      return read(await fetch(request.url, { headers: request.headers }))
    }
    case "page-fetch": {
      if (pageRequest === undefined && request.token === undefined)
        return [0, ""]
      // Decision: no cookies. Ajaib's REST API preflights with
      // `Access-Control-Allow-Origin: *`, which the browser refuses for a
      // credentialed request (seen 2026-11-11 on `v1/stock/data/list/`); the
      // bearer token in the headers is the session.
      return read(
        await fetch(
          new URL(request.path, pageRequest?.base ?? AJAIB_API_BASE),
          {
            headers: pageRequest?.headers ?? {
              authorization: `Bearer ${request.token}`,
            },
          }
        )
      )
    }
    case "page-post": {
      const response = await fetch(request.url, {
        method: "POST",
        headers: {
          ...pageRequest?.headers,
          "content-type": "application/json",
        },
        body: request.body,
        credentials: "include",
      })
      return [response.status, await response.text()]
    }
    case "page-token": {
      const header = Object.entries(pageRequest?.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "authorization"
      )?.[1]
      const token = header?.match(/^Bearer (.+)$/i)?.[1]
      return token === undefined ? [0, ""] : [200, token]
    }
  }
}

const reply = (request: TabRequest) =>
  request._tag === "activity" || request._tag === "type-pin"
    ? lockAnswer(request)
    : answer(request)

type SocketKey = `${SiteName}/${Connection}`

const sockets = new Map<SocketKey, WebSocket>()
const keyOf = (command: {
  site: SiteName
  connection: Connection
}): SocketKey => `${command.site}/${command.connection}`

const relay = () => {
  let port: chrome.runtime.Port
  try {
    port = chrome.runtime.connect({ name: feed })
  } catch {
    // The extension was reloaded or removed: this script is orphaned until
    // the tab reloads.
    return
  }
  const post = (event: BrokerEvent | PageEvent | Answer) => {
    try {
      port.postMessage(event)
    } catch {
      // The port closed; onDisconnect reconnects.
    }
  }
  // A new port's worker learns the lock as it stands.
  forward = post
  window.postMessage({ kumoraRelay: "ask-lock" }, location.origin)

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
        return void reply(command.request).then(
          ([status, body, challenge]) =>
            post({
              _tag: "answer",
              id: command.id,
              status,
              body,
              ...(challenge === undefined ? {} : { challenge }),
            }),
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
