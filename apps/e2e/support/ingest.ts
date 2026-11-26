import {
  IngestProtocolVersion,
  MarketLivePath,
  encodeIngestUp,
  type Feed,
  type IngestUp,
  StockCode,
} from "@workspace/relay"
import { expect, type APIRequestContext } from "@playwright/test"
import { DateTime, Effect } from "effect"
import { mkdirSync, readFileSync } from "node:fs"
import { WebSocket } from "ws"

import { DASHBOARD } from "./accounts"
import { WIB_OFFSET, marketNow, wibDate, wibTime } from "./clock"
import { wsFrame } from "./ws-frame"

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

/**
 * Today in WIB on the Test stage's Market Live clock, `YYYY-MM-DD`: the
 * trading-day object the page reads.
 */
export const wibToday = () => wibDate(marketNow())

// A run's workers share today's trading-day object and ask for
// fresh numbers and codes at the same instant, so the clock alone repeats
// them, and a trade whose number another test sent first is dropped as held.
// Each is claimed with a mkdir, which one process of the run wins; Playwright
// empties test-results before each run.
const CLAIMS = new URL("../test-results/claims/", import.meta.url)

// The first `n` from `from` up that no other caller of the run claimed.
function claim(kind: string, from: number) {
  mkdirSync(CLAIMS, { recursive: true })
  for (let n = from; ; n++)
    try {
      mkdirSync(new URL(`${kind}-${n}`, CLAIMS))
      return n
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
}

// The trade numbers a test may send above its base.
const TRADE_BLOCK = 100_000

/**
 * A test's base trade number: above every number an earlier test sent today's
 * object, so the test's trades are the newest and lead the tape whatever ran
 * before it. Every spec shares today's trading-day object, the tape lists the
 * newest trade numbers first in a window of about 30 rows, and a snapshot
 * carries only the 200 newest. It counts 100 numbers per millisecond of the
 * WIB day, and a test numbers at most TRADE_BLOCK trades above its base, a
 * block no other test of the run holds.
 */
export const freshTradeNumbers = () =>
  claim(
    "trades",
    Math.floor((((Date.now() + WIB_OFFSET) % 86_400_000) * 100) / TRADE_BLOCK)
  ) * TRADE_BLOCK

/**
 * A stock code of the test's own, `prefix` and a claimed number seeded from
 * the time: today's object keeps every code's candles, books and figures,
 * from earlier runs too, so a listed code would have a repeat's. No other
 * test of the run holds it.
 */
export const freshCode = (prefix: string) =>
  StockCode.make(
    `${prefix}${claim("code", Date.now()).toString(36).toUpperCase()}`
  )

/** `seq` as today's 18-digit Ajaib trade number. */
const ajaibTradeNumber = (today: string, seq: number) =>
  today.replaceAll("-", "") + String(seq).padStart(10, "0")

/**
 * The recorded session-1 frames moved to now on the market clock, so today's
 * trading-day object keeps them and Ajaib reads live: the trade number's date
 * prefix changes, and every trade, recorded at 09:00:00, is stamped with the
 * current second. Each trade number is `base` above the recorded one. Kept at
 * 09:00, they would trail the clock's 10:00 by an hour and read DELAYED for
 * the next 10 s of whatever test runs after.
 */
export function session1Today(base = 0): ReadonlyArray<string> {
  const now = marketNow()
  const today = wibDate(now)
  const tradedAt = `${today}T${wibTime(now)}.000+07:00`
  return recorded.session1.map((frame) => {
    const trade = JSON.parse(frame)
    return JSON.stringify({
      ...trade,
      tradeNum: ajaibTradeNumber(today, base + Number(trade.tradeNum.slice(8))),
      tradedAt,
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

// ws 8.22 honors `closeTimeout`; @types/ws 8.18.2, its latest, leaves it out.
const SOCKET_OPTIONS: WebSocket.ClientOptions & { closeTimeout: number } = {
  closeTimeout: 1_000,
}

// The ingest socket, open; `closed` settles with its close code.
const dial = async () => {
  // `ws`, not Node's built-in WebSocket, which reports `close` only
  // once workerd tears down TCP, 20 to 30 s or more after the close frame.
  // `ws` answers the close frame, then destroys the socket after
  // `closeTimeout`, so `closed` settles within it.
  const socket = new WebSocket(
    `${DASHBOARD.replace(/^http/, "ws")}${MarketLivePath.ingest}`,
    SOCKET_OPTIONS
  )
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code))
  )
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve)
    socket.addEventListener("error", reject)
  })
  return { socket, closed }
}

/** A client without the token: the ingest socket, opened and left silent. */
export async function openSilentIngest() {
  const { closed } = await dial()
  return { closed }
}

/**
 * Sends today's object the recorded code list and waits until it is stored.
 * Another spec's relay may have sent a list of its own earlier, so it waits
 * for this list's WIFI-R.
 */
export async function storeRecordedCodeList(request: APIRequestContext) {
  const relay = await openIngest()
  await relay.sendCodeList()
  const url = `${DASHBOARD}/market-live/days/${wibToday()}/codes`
  await expect
    .poll(async () => {
      const response = await request.get(url)
      return response.ok() && (await response.text()).includes('"WIFI-R"')
    })
    .toBe(true)
  relay.close()
}

/** A fake relay: the ingest socket, opened with `token`. */
export async function openIngest(token = TEST_INGEST_TOKEN) {
  const { socket, closed } = await dial()
  // Every message the object sent down, as text; none comes before the
  // token.
  const received: Array<string> = []
  socket.addEventListener("message", (event) =>
    received.push(wsFrame(event.data).toString())
  )
  await send(socket, {
    _tag: "Token",
    protocolVersion: IngestProtocolVersion,
    token,
  })
  return {
    closed,
    received,
    sendAjaib: (frames: ReadonlyArray<string>) =>
      send(socket, {
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Ajaib",
        stream: "trade",
        connection: "A",
        receivedAt: DateTime.nowUnsafe(),
        frames,
      }),
    sendStockbit: (frames: ReadonlyArray<Uint8Array>) =>
      send(socket, {
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Stockbit",
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
