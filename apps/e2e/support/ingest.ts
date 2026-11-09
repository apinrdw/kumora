import {
  IngestProtocolVersion,
  MarketLivePath,
  encodeIngestUp,
  type Feed,
  type IngestUp,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { readFileSync } from "node:fs"

import { DASHBOARD } from "./accounts"
import { marketNow } from "./clock"

/** The Test stage's INGEST_TOKEN (playwright.config.ts sets it). */
export const TEST_INGEST_TOKEN = "e2e-ingest-token-not-a-secret"

// Recorded Ajaib TRADE frames from 2026-11-09, shared with the trading-day
// Durable Object's tests.
const recorded: {
  readonly openingMatch: ReadonlyArray<string>
  readonly session1: ReadonlyArray<string>
} = JSON.parse(
  readFileSync(
    new URL(
      "../../dashboard/tests/server/market-live/fixtures/ajaib-trades-2026-11-09.json",
      import.meta.url
    ),
    "utf8"
  )
)

// Today in WIB on the Test stage's Market Live clock, `YYYY-MM-DD`: the
// trading-day object the page reads.
const wibToday = () =>
  new Date(marketNow() + 7 * 3_600_000).toISOString().slice(0, 10)

/**
 * The recorded session-1 frames moved to today, so today's trading-day object
 * keeps them: the trade number's date prefix and the trade's date change, the
 * WIB time of day stays.
 */
export function session1Today(): ReadonlyArray<string> {
  const today = wibToday()
  return recorded.session1.map((frame) => {
    const trade = JSON.parse(frame)
    return JSON.stringify({
      ...trade,
      tradeNum: today.replaceAll("-", "") + trade.tradeNum.slice(8),
      tradedAt: today + trade.tradedAt.slice(10),
    })
  })
}

const send = async (socket: WebSocket, message: IngestUp) =>
  socket.send(await Effect.runPromise(encodeIngestUp(message)))

/** A fake relay: the ingest socket, opened with `token`. */
export async function openIngest(token = TEST_INGEST_TOKEN) {
  const socket = new WebSocket(
    `${DASHBOARD.replace(/^http/, "ws")}${MarketLivePath.ingest}`
  )
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code))
  )
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve)
    socket.addEventListener("error", reject)
  })
  await send(socket, {
    _tag: "Token",
    protocolVersion: IngestProtocolVersion,
    token,
  })
  return {
    closed,
    sendAjaib: (frames: ReadonlyArray<string>) =>
      send(socket, {
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Ajaib",
        connection: "A",
        receivedAt: DateTime.nowUnsafe(),
        frames,
      }),
    /** Reports one of a feed's connections alive (a ping reply) or closed. */
    report: (
      feed: Feed,
      status: "alive" | "closed",
      connection: "A" | "B" = "A"
    ) =>
      send(socket, {
        _tag: "FeedStatus",
        protocolVersion: IngestProtocolVersion,
        feed,
        connection,
        at: DateTime.nowUnsafe(),
        status,
      }),
    close: () => socket.close(),
  }
}
