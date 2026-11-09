import {
  IngestProtocolVersion,
  MarketLivePath,
  encodeIngestUp,
  type IngestUp,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { readFileSync } from "node:fs"

import { DASHBOARD } from "./accounts"

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

/**
 * Ajaib's recorded stock code list response from 2026-11-09, trimmed to 13
 * codes (BBCA, BBRI, BREN, GOTO, WIFI and its right WIFI-R, AMAG and its
 * warrant AMAG-W2…), shared with the trading-day Durable Object's tests.
 */
const RECORDED_CODE_LIST: string = JSON.parse(
  readFileSync(
    new URL(
      "../../dashboard/tests/server/market-live/fixtures/ajaib-code-list-2026-11-09.json",
      import.meta.url
    ),
    "utf8"
  )
).body

/** Today in WIB, `YYYY-MM-DD`: the trading-day object the page reads. */
export const wibToday = () =>
  new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)

/**
 * A test's base trade number: above every number an earlier test sent today's
 * object, so the test's trades are the newest and lead the tape whatever ran
 * before it. Every spec shares today's trading-day object, the tape lists the
 * newest trade numbers first in a window of about 30 rows, and a snapshot
 * carries only the 200 newest. It counts 100 numbers per millisecond of the
 * WIB day, so a test numbers at most 100,000 trades above its base (the
 * next test asks for its own base seconds later).
 */
export const freshTradeNumbers = () =>
  ((Date.now() + 7 * 3_600_000) % 86_400_000) * 100

/** `seq` as today's 18-digit Ajaib trade number. */
const ajaibTradeNumber = (today: string, seq: number) =>
  today.replaceAll("-", "") + String(seq).padStart(10, "0")

/**
 * The recorded session-1 frames moved to today, so today's trading-day object
 * keeps them: the trade number's date prefix and the trade's date change, the
 * WIB time of day stays. Each trade number is `base` above the recorded one.
 */
export function session1Today(base = 0): ReadonlyArray<string> {
  const today = wibToday()
  return recorded.session1.map((frame) => {
    const trade = JSON.parse(frame)
    return JSON.stringify({
      ...trade,
      tradeNum: ajaibTradeNumber(today, base + Number(trade.tradeNum.slice(8))),
      tradedAt: today + trade.tradedAt.slice(10),
    })
  })
}

/** One Ajaib TRADE frame for today, numbered `seq` at WIB `time` (HH:MM:SS). */
export function ajaibTradeToday(trade: {
  readonly seq: number
  readonly time: string
  readonly ticker: string
  readonly price: number
  readonly lot: number
  readonly type?: "BUY" | "SELL"
  readonly board?: "RG" | "TN" | "NG"
}): string {
  const today = wibToday()
  return JSON.stringify({
    ticker: trade.ticker,
    type: trade.type ?? "BUY",
    price: trade.price,
    lot: trade.lot,
    value: trade.price * trade.lot * 100,
    tradedAt: `${today}T${trade.time}.000+07:00`,
    tradeNum: ajaibTradeNumber(today, trade.seq),
    ...(trade.board === undefined ? {} : { market_type: trade.board }),
  })
}

/**
 * An opening match of `count` prints today, numbered from `base` + 1, at
 * 08:58:00 over 676 stock codes, as the 2026-11-09 match was (22,264 prints,
 * Ajaib typing them SELL).
 */
export function openingMatchToday(
  count: number,
  base = 0
): ReadonlyArray<string> {
  return Array.from({ length: count }, (_, i) =>
    ajaibTradeToday({
      seq: base + i + 1,
      time: "08:58:00",
      ticker: `M${String.fromCharCode(65 + (i % 26), 65 + (Math.floor(i / 26) % 26))}X`,
      price: 100 + (i % 50),
      lot: 1 + (i % 9),
      type: "SELL",
    })
  )
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
    sendCodeList: (body = RECORDED_CODE_LIST) =>
      send(socket, {
        _tag: "CodeList",
        protocolVersion: IngestProtocolVersion,
        receivedAt: DateTime.nowUnsafe(),
        body,
      }),
    close: () => socket.close(),
  }
}
