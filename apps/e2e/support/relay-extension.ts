import { parseStage, stageUrl } from "@workspace/deploy"
import {
  WibDate,
  decodeIngestUp,
  encodeBrokerCodesStatus,
  encodeIngestDown,
  type BrokerCodesStatus,
  type IngestDown,
  type IngestUp,
} from "@workspace/relay"
import { chromium, expect, type Worker } from "@playwright/test"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import {
  createServer as createHttpServer,
  type ServerResponse,
} from "node:http"
import { createServer, type Server } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer, type WebSocket } from "ws"

import { wibInstant } from "./clock"
import { closeWhenTestEnds } from "./test"
import { recordVideo } from "./video"

/** The built extension (`pnpm --filter extension build`, run by `pnpm e2e`). */
const EXTENSION = fileURLToPath(
  new URL("../../extension/dist", import.meta.url)
)

export const AJAIB_TAB = "https://trade.ajaib.co.id/"
export const STOCKBIT_TAB = "https://stockbit.com/"

/** Production's dashboard, as the built extension names it. */
const PRODUCTION_HOST = new URL(
  Effect.runSync(
    Effect.orDie(
      Effect.flatMap(parseStage("production"), (stage) =>
        stageUrl("dashboard", stage)
      )
    )
  )
).host

/**
 * Every host the fakes answer for, all on one local port: the brokers', and
 * Production's dashboard, whose broker codes statuses a test sets.
 */
const HOSTS = [
  "trade.ajaib.co.id",
  "stream.ajaib.co.id",
  "ht2.ajaib.co.id",
  "stockbit.com",
  "exodus.stockbit.com",
  "wss-jkt.trading.stockbit.com",
  PRODUCTION_HOST,
]

const BROKER_CODES_PATH = /^\/api\/broker-codes\/(\d{4}-\d{2}-\d{2})$/

// A day's broker codes status, by day; none answers 404.
export type DayStatuses = (day: WibDate) => BrokerCodesStatus | undefined

// Answers a broker codes status GET from `statuses`.
const answerStatus = (
  statuses: DayStatuses,
  path: string,
  response: ServerResponse
) => {
  const day = BROKER_CODES_PATH.exec(path)?.[1]
  const status = day === undefined ? undefined : statuses(WibDate.make(day))
  if (status === undefined) {
    response.writeHead(404)
    return response.end()
  }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(Effect.runSync(encodeBrokerCodesStatus(status)))
}

/** One socket the relay opened to a fake broker, and what it sent. */
export interface BrokerSocket {
  readonly path: string
  readonly protocol: string
  readonly socket: WebSocket
  readonly received: Array<string | Uint8Array>
}

// The relay ticks every 10 s, so B, pings and reopens each take up to a tick
// or two. A moved clock ticks it at once (setRelayClock).
export const TICKS = { timeout: 25_000 }

// A trading day's session 1 (a Tuesday), for the relay's schedule only.
export const SESSION_1 = "2026-11-10T10:00:00"

export const PING = '{"method":"SUBSCRIBE","streamObject":"PING-WEB"}'

// What a socket received, its pings left out.
export const sent = (socket: BrokerSocket | undefined) =>
  (socket?.received ?? []).filter((message) => message !== PING)

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
  // Production's broker codes statuses; a test sets them.
  const production: { statuses: DayStatuses } = { statuses: () => undefined }
  const sockets: Array<BrokerSocket> = []
  const requests: Array<{ path: string; headers: Record<string, unknown> }> = []
  const server: Server = createServer(
    selfSignedCertificate(),
    (request, response) => {
      const host = request.headers.host?.split(":")[0]
      const path = request.url ?? "/"
      requests.push({ path, headers: request.headers })
      if (host === PRODUCTION_HOST)
        return answerStatus(production.statuses, path, response)
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
        // The 2026-11-09 capture's shape: the list under `results`.
        return response.end(
          JSON.stringify({
            err_code: "EC0000000",
            results: LISTED_CODES.map((code) => ({ code, name: code })),
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
    production,
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
 * A fake dashboard's ingest socket for the extra target: it accepts any
 * token, keeps what the relay sends up with when it arrived, and sends down
 * what the test tells it.
 */
export async function startFakeIngest() {
  // Its broker codes statuses; a test sets them. The extension holds no
  // host permission for an extra target, so the fake allows its origin.
  const brokerCodes: { statuses: DayStatuses } = { statuses: () => undefined }
  const server = createHttpServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-headers", "authorization")
    if (request.method === "OPTIONS") return response.end()
    answerStatus(brokerCodes.statuses, request.url ?? "/", response)
  })
  const sockets: Array<WebSocket> = []
  // Stamped on arrival and decoded only when read, each once, so a busy
  // relay's envelopes are timed as they arrive.
  const received: Array<{ text: string; at: number }> = []
  const decoded: Array<{ message: IngestUp; at: number }> = []
  new WebSocketServer({ server }).on("connection", (socket) => {
    sockets.push(socket)
    socket.on("message", (data) =>
      received.push({ text: String(data), at: Date.now() })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  /** Every envelope the relay sent up, and when it arrived (epoch ms). */
  const messages = async (): Promise<
    ReadonlyArray<{ message: IngestUp; at: number }>
  > => {
    const unread = received.splice(0)
    const fresh = await Effect.runPromise(
      Effect.forEach(unread, ({ text, at }) =>
        Effect.map(Effect.option(decodeIngestUp(text)), (message) =>
          message._tag === "Some" ? [{ message: message.value, at }] : []
        )
      )
    )
    decoded.push(...fresh.flat())
    return decoded
  }
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    brokerCodes,
    sockets,
    messages,
    /** Every BackfillPage the relay sent up: feed, range and body. */
    backfillPages: () =>
      messages().then((all) =>
        all.flatMap(({ message }) =>
          message._tag === "BackfillPage" ? [message] : []
        )
      ),
    sendDown: async (message: IngestDown) => {
      const text = await Effect.runPromise(encodeIngestDown(message))
      for (const socket of sockets) socket.send(text)
    },
    close: async () => {
      for (const socket of sockets) socket.terminate()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// The relay's test clock offset in chrome.storage.local, as
// apps/extension/src/worker/settings.ts names it.
const CLOCK_OFFSET_KEY = "clockOffsetMs"
// The offset of the relay's last completed tick on the worker's global scope,
// as apps/extension/src/worker/service-worker.ts names it.
const LAST_TICK_KEY = "lastTickClockOffsetMs"

// Sets the relay's clock offset, which ticks it at once, and waits until a
// tick on that offset has completed.
async function setClockOffset(worker: Worker, offset: number) {
  await worker.evaluate(
    `chrome.storage.local.set({ ${CLOCK_OFFSET_KEY}: ${offset} })`
  )
  await expect
    .poll(() => worker.evaluate(`globalThis.${LAST_TICK_KEY}`))
    .toBe(offset)
}

/**
 * Moves the relay's schedule clock so that it reads `wib` (a WIB wall-clock
 * time, `YYYY-MM-DDTHH:MM:SS`) now, and waits for the tick on it. Frames keep
 * their real times.
 */
export async function setRelayClock(worker: Worker, wib: string) {
  await setClockOffset(worker, wibInstant(wib) - Date.now())
}

/** Ticks the relay `count` times, each awaited, by moving its clock 1 ms on. */
export async function tickRelay(worker: Worker, count = 1) {
  for (let tick = 0; tick < count; tick++) {
    const offset = await worker.evaluate<number>(
      `chrome.storage.local.get("${CLOCK_OFFSET_KEY}").then((stored) => stored.${CLOCK_OFFSET_KEY} ?? 0)`
    )
    await setClockOffset(worker, offset + 1)
  }
}

/**
 * Chromium with the built extension loaded, and every broker host (any port)
 * mapped to the fakes on `port`. `test` closes it when the test ends.
 */
export async function launchWithExtension(port: number) {
  const rules = HOSTS.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(", ")
  const context = closeWhenTestEnds(
    await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        `--host-resolver-rules=${rules}`,
        "--ignore-certificate-errors",
      ],
      ...recordVideo(),
    })
  )
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  const extensionId = new URL(worker.url()).host
  return {
    context,
    worker,
    optionsUrl: `chrome-extension://${extensionId}/options.html`,
  }
}
