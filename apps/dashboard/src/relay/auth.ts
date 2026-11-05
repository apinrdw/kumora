import { INGEST_PROTOCOL, TRADES_QUERY } from "./routes"
import { isTicketSubject, sameSecret, verifyTicket } from "./ticket"

/* The route checks `server.ts` runs. Each returns the refusal, or null to pass. */

const refuse = (status: number, body: string) => new Response(body, { status })

const notUpgrade = (request: Request) =>
  request.headers.get("Upgrade")?.toLowerCase() !== "websocket"

/**
 * `GET /ws/ingest`: the `kumora-relay` protocol and nothing else. The secret comes
 * after the upgrade, in the socket's first message, because the upgrade's headers
 * are logged. `TradeRelay` checks it.
 */
export const checkIngest = (request: Request): Response | null => {
  if (notUpgrade(request)) return refuse(426, "expected a websocket")
  return request.headers.get("Sec-WebSocket-Protocol")?.trim() ===
    INGEST_PROTOCOL
    ? null
    : refuse(403, "forbidden")
}

/** Operator tooling: `Authorization: Bearer <secret>`, the secret of the route's feature. */
export const checkOperator = (
  request: Request,
  secret: string
): Response | null => {
  const header = request.headers.get("Authorization") ?? ""
  return header.startsWith("Bearer ") &&
    sameSecret(header.slice("Bearer ".length), secret)
    ? null
    : refuse(403, "forbidden")
}

/** `GET /ws/trades`: the request's own origin, and a ticket for that symbol. */
export const checkClient = async (
  request: Request,
  secret: string,
  now: number
): Promise<Response | null> => {
  if (notUpgrade(request)) return refuse(426, "expected a websocket")
  const url = new URL(request.url)
  if (request.headers.get("Origin") !== url.origin)
    return refuse(403, "forbidden origin")
  const symbol = url.searchParams.get(TRADES_QUERY.symbol)
  const ticket = url.searchParams.get(TRADES_QUERY.ticket) ?? ""
  return isTicketSubject(symbol) &&
    (await verifyTicket(secret, ticket, symbol, now))
    ? null
    : refuse(403, "bad ticket")
}
