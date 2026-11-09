import { chromium } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:https"
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

/** One socket the relay opened to the fake Ajaib, and what it sent. */
interface AjaibSocket {
  readonly socket: WebSocket
  readonly received: Array<string>
}

// A self-signed certificate for the fake broker hosts, which Chromium is told
// to accept.
function selfSignedCertificate() {
  const dir = mkdtempSync(join(tmpdir(), "fake-ajaib-"))
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
      "/CN=ajaib.co.id",
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

/**
 * A fake Ajaib on one local HTTPS port: a blank page for the tab, and the
 * trade stream's websocket, which answers PING-WEB like Ajaib does.
 */
export async function startFakeAjaib() {
  const server = createServer(selfSignedCertificate(), (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<!doctype html><title>Fake Ajaib</title><p>Fake Ajaib</p>")
  })
  const sockets: Array<AjaibSocket> = []
  const streams = new WebSocketServer({ server, path: "/ws/trade" })
  streams.on("connection", (socket) => {
    const entry: AjaibSocket = { socket, received: [] }
    sockets.push(entry)
    socket.on("message", (data) => {
      const text = String(data)
      entry.received.push(text)
      if (text.includes("PING-WEB"))
        socket.send(
          JSON.stringify({ message: "already have active subscription" })
        )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as AddressInfo).port,
    sockets,
    close: async () => {
      for (const { socket } of sockets) socket.terminate()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Chromium with the built extension loaded, and both Ajaib hosts (the tab's
 * and the stream's, any port) mapped to the fake on `port`.
 */
export async function launchWithExtension(port: number) {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--host-resolver-rules=MAP trade.ajaib.co.id 127.0.0.1:${port}, MAP stream.ajaib.co.id 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
    ],
  })
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  const extensionId = new URL(worker.url()).host
  return {
    context,
    optionsUrl: `chrome-extension://${extensionId}/options.html`,
  }
}
