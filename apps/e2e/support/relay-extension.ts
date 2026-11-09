import { chromium, type Worker } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer, type WebSocket } from "ws"

/** The built extension (`pnpm --filter extension build`, run by `pnpm e2e`). */
const EXTENSION = fileURLToPath(
  new URL("../../extension/dist", import.meta.url)
)

export const AJAIB_TAB = "https://trade.ajaib.co.id/"
export const STOCKBIT_TAB = "https://stockbit.com/"

/** Every broker host the fakes answer for, all on one local port. */
const HOSTS = [
  "trade.ajaib.co.id",
  "stream.ajaib.co.id",
  "ht2.ajaib.co.id",
  "stockbit.com",
  "exodus.stockbit.com",
  "wss-jkt.trading.stockbit.com",
]

/** One socket the relay opened to a fake broker, and what it sent. */
export interface BrokerSocket {
  readonly path: string
  readonly protocol: string
  readonly socket: WebSocket
  readonly received: Array<string | Uint8Array>
}

// A self-signed certificate for the fake broker hosts, which Chromium is told
// to accept.
function selfSignedCertificate() {
  const dir = mkdtempSync(join(tmpdir(), "fake-brokers-"))
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=fake-broker",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" }
  )
  return {
    key: readFileSync(join(dir, "key.pem")),
    cert: readFileSync(join(dir, "cert.pem")),
  }
}

const base64Url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url")

/** The fake Stockbit user's access token: a JWT naming user 4242. */
export const STOCKBIT_TOKEN = `${base64Url({ alg: "HS256" })}.${base64Url({ data: { uid: 4242 } })}.c2ln`
export const STOCKBIT_KEY = "fake-websocket-key"

/** The fake Ajaib account's id, as its access token's `sub` names it. */
export const AJAIB_USER_ID = 4999301

/** Ajaib's PIN check's answers, as the owner saw them on 2026-11-09. */
export const PIN_ANSWERS = {
  approved: {
    err_code: "EC0000000",
    err_message: "APPROVED/OK",
    result: {
      valid: true,
      access_token: `${base64Url({ alg: "HS256" })}.${base64Url({ sub: AJAIB_USER_ID })}.c2ln`,
      refresh_token: `${base64Url({ alg: "HS256" })}.${base64Url({ sub: AJAIB_USER_ID })}.cmVm`,
      is_pin_6digit: true,
      show_2fa: false,
    },
  },
  refused: {
    err_code: "EC0000012",
    err_message: "INVALID PIN",
    result: {
      valid: false,
      access_token: "",
      refresh_token: "",
      is_pin_6digit: true,
      show_2fa: false,
    },
  },
}

/** The fake Ajaib page's own REST header, which its code list requires. */
const AJAIB_HEADER = "x-fake-ajaib-page"

/** Ajaib's stock code list, as the fake answers it. */
export const LISTED_CODES = ["BBCA", "BRMS", "ENRG", "TLKM"]

// The fake Ajaib page calls its own API once it loads, as Ajaib's does; the
// relay's MAIN-world wrapper sees that call's headers.
const AJAIB_PAGE = `<!doctype html><title>Fake Ajaib</title><p>Fake Ajaib</p>
<script>fetch("/api/v1/user/profile/", { headers: { "${AJAIB_HEADER}": "yes" } })</script>`

// Stockbit's session cookie holds the access token, readable from scripts.
const STOCKBIT_CREDENTIAL = encodeURIComponent(
  JSON.stringify({ accessToken: STOCKBIT_TOKEN })
)

// WebsocketWrapMessageChannel { ping (2): { message: "pong" } }
const PONG = Uint8Array.from([0x12, 0x06, 0x0a, 0x04, ...Buffer.from("pong")])

/**
 * Fake Stockbit and Ajaib on one local HTTPS port, told apart by host: each
 * site's page for its tab, Stockbit's websocket key and Ajaib's code list
 * REST routes, and every relay socket, which answers pings like the real
 * ones do.
 */
export async function startFakeBrokers() {
  // The REST running-trade tapes' answers, by query; a test sets them.
  const tapes: {
    stockbit: (query: URLSearchParams) => unknown
    ajaib: (query: URLSearchParams) => unknown
  } = {
    stockbit: () => ({ data: { running_trade: [] } }),
    ajaib: () => ({ results: [], has_next: false }),
  }
  // The PIN check's answer; a test sets it. Every body it was sent.
  const pin: { answer: unknown; bodies: Array<string> } = {
    answer: PIN_ANSWERS.approved,
    bodies: [],
  }
  const sockets: Array<BrokerSocket> = []
  const requests: Array<{ path: string; headers: Record<string, unknown> }> = []
  const server: Server = createServer(
    selfSignedCertificate(),
    (request, response) => {
      const host = request.headers.host?.split(":")[0]
      const path = request.url ?? "/"
      requests.push({ path, headers: request.headers })
      if (host === "exodus.stockbit.com") {
        response.setHeader(
          "access-control-allow-origin",
          STOCKBIT_TAB.slice(0, -1)
        )
        response.setHeader("access-control-allow-headers", "authorization")
        if (request.method === "OPTIONS") return response.end()
        const authorized =
          request.headers.authorization === `Bearer ${STOCKBIT_TOKEN}`
        response.writeHead(authorized ? 200 : 401, {
          "content-type": "application/json",
        })
        const url = new URL(path, "https://exodus.stockbit.com")
        return response.end(
          JSON.stringify(
            url.pathname === "/order-trade/running-trade"
              ? tapes.stockbit(url.searchParams)
              : { message: "ok", data: { key: STOCKBIT_KEY } }
          )
        )
      }
      if (host === "ht2.ajaib.co.id") {
        response.setHeader(
          "access-control-allow-origin",
          AJAIB_TAB.slice(0, -1)
        )
        response.setHeader("access-control-allow-credentials", "true")
        response.setHeader(
          "access-control-allow-headers",
          `content-type, ${AJAIB_HEADER}`
        )
        if (request.method === "OPTIONS") return response.end()
        let body = ""
        request.on("data", (chunk) => (body += String(chunk)))
        return request.on("end", () => {
          if (path === "/api/v5/users/me/pin/validate") pin.bodies.push(body)
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify(pin.answer))
        })
      }
      if (host === "stockbit.com") {
        response.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": `credentialStorage=${STOCKBIT_CREDENTIAL}; Path=/; Secure`,
        })
        return response.end("<!doctype html><title>Fake Stockbit</title>")
      }
      if (path === "/api/v1/stock/data/list/") {
        const page = request.headers[AJAIB_HEADER] === "yes"
        response.writeHead(page ? 200 : 403, {
          "content-type": "application/json",
        })
        return response.end(
          JSON.stringify({
            data: LISTED_CODES.map((code) => ({ code, name: code })),
          })
        )
      }
      if (path.startsWith("/api/v1/stock/detail/running_trades/")) {
        const page = request.headers[AJAIB_HEADER] === "yes"
        response.writeHead(page ? 200 : 403, {
          "content-type": "application/json",
        })
        const url = new URL(path, "https://trade.ajaib.co.id")
        return response.end(JSON.stringify(tapes.ajaib(url.searchParams)))
      }
      if (path.startsWith("/api/")) return response.end("{}")
      response.writeHead(200, { "content-type": "text/html" })
      response.end(AJAIB_PAGE)
    }
  )
  const streams = new WebSocketServer({
    server,
    handleProtocols: (protocols) => (protocols.has("web") ? "web" : false),
  })
  streams.on("connection", (socket, request) => {
    const entry: BrokerSocket = {
      path: request.url ?? "",
      protocol: socket.protocol,
      socket,
      received: [],
    }
    sockets.push(entry)
    socket.on("message", (data, binary) => {
      const message = binary ? new Uint8Array(data as Buffer) : String(data)
      entry.received.push(message)
      if (typeof message === "string" && message.includes("PING-WEB"))
        socket.send(
          JSON.stringify({ message: "already have active subscription" })
        )
      // WebsocketRequest { ping (4): { message: "ping" } }
      if (typeof message !== "string" && message[0] === 0x22) socket.send(PONG)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as AddressInfo).port,
    tapes,
    pin,
    sockets,
    requests,
    /** The sockets opened on one path, oldest first. */
    on: (path: string) => sockets.filter((socket) => socket.path === path),
    close: async () => {
      for (const { socket } of sockets) socket.terminate()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Moves the relay's schedule clock so that it reads `wib` (a WIB wall-clock
 * time, `YYYY-MM-DDTHH:MM:SS`) now. Frames keep their real times.
 */
export async function setRelayClock(worker: Worker, wib: string) {
  const offset = Date.parse(`${wib}+07:00`) - Date.now()
  await worker.evaluate(
    `chrome.storage.local.set({ clockOffsetMs: ${offset} })`
  )
}

/**
 * Chromium with the built extension loaded, and every broker host (any port)
 * mapped to the fakes on `port`.
 */
export async function launchWithExtension(port: number) {
  const rules = HOSTS.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(", ")
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--host-resolver-rules=${rules}`,
      "--ignore-certificate-errors",
    ],
  })
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  const extensionId = new URL(worker.url()).host
  return {
    context,
    worker,
    optionsUrl: `chrome-extension://${extensionId}/options.html`,
  }
}
