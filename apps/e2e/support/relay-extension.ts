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
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Worker,
} from "@playwright/test"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs"
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

/** The built extension (`vp run --filter extension build`, run by `vp run e2e`). */
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

// A status GET answers the same status whatever its `?after=` names.
const BROKER_CODES_PATH = /^\/api\/broker-codes\/(\d{4}-\d{2}-\d{2})(?:\?.*)?$/

// A day's broker codes status, by day; none answers 404.
type DayStatuses = (day: WibDate) => BrokerCodesStatus | undefined

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

/** The static headers the fake Ajaib page sends on its calls, as Ajaib's does. */
export const AJAIB_STATIC_HEADERS = {
  "x-ht-ver-id": "fake-ver-7",
  "x-product": "fake-product",
  "x-platform": "web",
  "x-device-name": "fake-device",
  "x-web-version": "9.9.9",
  "x-app-mode": "fake-mode",
  accept: "application/json, text/plain, */*",
}

/** The page call's own token and device signature, which are never kept. */
export const AJAIB_PAGE_TOKEN = "fake-ajaib-token"
export const AJAIB_DEVICE_SIGNATURE = "fake-device-signature"

// The fake Ajaib page calls its own API once it loads, signed `jwt <token>`
// as Ajaib's is, then sends a token-less beacon under the same path, which
// the relay's MAIN-world wrapper must not take for the page's headers.
const AJAIB_PAGE_HEADERS = JSON.stringify({
  ...AJAIB_STATIC_HEADERS,
  [AJAIB_HEADER]: "yes",
  authorization: `jwt ${AJAIB_PAGE_TOKEN}`,
  "x-device-signature": AJAIB_DEVICE_SIGNATURE,
})
const AJAIB_PAGE = `<!doctype html><title>Fake Ajaib</title><p>Fake Ajaib</p>
<script>fetch("/api/v1/user/profile/", { headers: ${AJAIB_PAGE_HEADERS} })
  .then(() => fetch("/api/v1/log/", { method: "POST", headers: { "content-type": "text/plain" }, body: "beacon" }))</script>`
// The page after the close, when Ajaib's drives its data over sockets: no
// REST call of its own.
const SILENT_AJAIB_PAGE =
  "<!doctype html><title>Fake Ajaib</title><p>Fake Ajaib</p>"

// Stockbit's session cookies as a Google sign-in leaves them
// (apinrdw/kumora#591): `credentialStorage` holds the user and no token, and
// `sb_social_access_token` holds the access token. The fake serves the token
// HttpOnly, the case a page's scripts can't read; whether Stockbit's own is
// HttpOnly is unknown.
const STOCKBIT_COOKIES = [
  `credentialStorage=${encodeURIComponent(
    JSON.stringify({ state: { user: { id: 4242 } }, version: 0 })
  )}; Path=/; Secure`,
  `sb_social_access_token=${STOCKBIT_TOKEN}; Domain=stockbit.com; Path=/; Secure; HttpOnly`,
]

// WebsocketWrapMessageChannel { ping (2): { message: "pong" } }
const PONG = Uint8Array.from([0x12, 0x06, 0x0a, 0x04, ...Buffer.from("pong")])

/**
 * Fake Stockbit and Ajaib on one local HTTPS port, told apart by host: each
 * site's page for its tab, Stockbit's websocket key and Ajaib's code list
 * REST routes, and every relay socket, which answers pings like the real
 * ones do.
 */
export async function startFakeBrokers() {
  // The REST running-trade tapes' answers, by query, Ajaib's market status
  // and its Done Details pages; a test sets them. Ajaib's market isn't
  // CLOSED until a test says so.
  const tapes: {
    stockbit: (query: URLSearchParams) => unknown
    ajaib: (query: URLSearchParams) => unknown
    ajaibStatus: () => unknown
    doneDetails: (query: URLSearchParams) => unknown
  } = {
    stockbit: () => ({ data: { running_trade: [] } }),
    ajaib: () => ({ results: [], has_next: false }),
    ajaibStatus: () => ({}),
    doneDetails: () => ({ result: { has_next: false, transactions: [] } }),
  }
  // The PIN check's answer; a test sets it. Every body it was sent.
  const pin: { answer: unknown; bodies: Array<string> } = {
    answer: PIN_ANSWERS.approved,
    bodies: [],
  }
  // Production's broker codes statuses; a test sets them. Every batch
  // posted to it, as JSON, which it answers 200.
  const production: { statuses: DayStatuses; batches: Array<unknown> } = {
    statuses: () => undefined,
    batches: [],
  }
  // Whether the Ajaib page makes its own REST call as it loads; a test
  // turns it off.
  const ajaibPage = { calls: true }
  const sockets: Array<BrokerSocket> = []
  const requests: Array<{ path: string; headers: Record<string, unknown> }> = []
  const server: Server = createServer(
    selfSignedCertificate(),
    (request, response) => {
      const host = request.headers.host?.split(":")[0]
      const path = request.url ?? "/"
      requests.push({ path, headers: request.headers })
      if (host === PRODUCTION_HOST && request.method === "POST") {
        let body = ""
        request.on("data", (chunk) => (body += String(chunk)))
        return request.on("end", () => {
          production.batches.push(JSON.parse(body))
          response.writeHead(200)
          response.end()
        })
      }
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
          [
            "content-type",
            "authorization",
            "x-device-signature",
            AJAIB_HEADER,
            ...Object.keys(AJAIB_STATIC_HEADERS),
          ].join(", ")
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
          "set-cookie": STOCKBIT_COOKIES,
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
      const ajaibRest: Record<
        string,
        ((query: URLSearchParams) => unknown) | undefined
      > = {
        "/api/v1/stock/detail/running_trades/": tapes.ajaib,
        "/api/v1/stock/data/trading-day/time/": tapes.ajaibStatus,
        "/api/v1/stock/data/broker-transaction": tapes.doneDetails,
      }
      const url = new URL(path, "https://trade.ajaib.co.id")
      const rest = ajaibRest[url.pathname]
      if (rest !== undefined) {
        const page = request.headers[AJAIB_HEADER] === "yes"
        response.writeHead(page ? 200 : 403, {
          "content-type": "application/json",
        })
        return response.end(JSON.stringify(rest(url.searchParams)))
      }
      if (path.startsWith("/api/")) return response.end("{}")
      response.writeHead(200, { "content-type": "text/html" })
      response.end(ajaibPage.calls ? AJAIB_PAGE : SILENT_AJAIB_PAGE)
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
    ajaibPage,
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

/** The file in a test's output directory with its service workers' console. */
export const WORKER_CONSOLE = "service-worker-console.txt"

// Writes every console message of the context's service workers, the one it
// has and any that start later, to the test's WORKER_CONSOLE, one line each
// with its type, so a failed test keeps the worker's logs.
function writeWorkerConsole(context: BrowserContext) {
  const file = test.info().outputPath(WORKER_CONSOLE)
  appendFileSync(file, "")
  const heard = new Set<Worker>()
  const listen = (worker: Worker) => {
    if (heard.has(worker)) return
    heard.add(worker)
    worker.on("console", (message) =>
      appendFileSync(
        file,
        `[${message.type()}] ${message.text().replaceAll("\n", "\\n")}\n`
      )
    )
  }
  context.on("serviceworker", listen)
  for (const worker of context.serviceWorkers()) listen(worker)
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
  writeWorkerConsole(context)
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  const extensionId = new URL(worker.url()).host
  return {
    context,
    worker,
    optionsUrl: `chrome-extension://${extensionId}/options.html`,
  }
}
