import { describe, expect, test } from "vitest"

import { checkClient, checkIngest, checkOperator } from "@/relay/auth"
import { Symbol } from "@/domain/symbol"
import { MARKET } from "@/relay/routes"
import { mintTicket } from "@/relay/ticket"

const INGEST = "ingest-secret"
const TICKET = "ticket-secret"
const NOW = 1_800_000_000_000
const ORIGIN = "https://dash.example"
const BBCA = Symbol.make("BBCA")

const ingest = (headers: Record<string, string>) =>
  new Request(`${ORIGIN}/ws/ingest`, { headers })

describe("checkIngest", () => {
  const upgrade = { Upgrade: "websocket" }

  test("passes the kumora-relay protocol alone, with no secret in the request", () => {
    expect(
      checkIngest(
        ingest({ ...upgrade, "Sec-WebSocket-Protocol": "kumora-relay" })
      )
    ).toBeNull()
  })

  test("refuses a second protocol, so no client goes on sending the secret there", () => {
    expect(
      checkIngest(
        ingest({
          ...upgrade,
          "Sec-WebSocket-Protocol": `kumora-relay, ${INGEST}`,
        })
      )?.status
    ).toBe(403)
  })

  test("refuses another protocol name, and none", () => {
    expect(
      checkIngest(ingest({ ...upgrade, "Sec-WebSocket-Protocol": "other" }))
        ?.status
    ).toBe(403)
    expect(checkIngest(ingest(upgrade))?.status).toBe(403)
  })

  test("rejects a request that is not an upgrade", () => {
    expect(
      checkIngest(ingest({ "Sec-WebSocket-Protocol": "kumora-relay" }))?.status
    ).toBe(426)
  })
})

describe("checkOperator", () => {
  const status = (headers: Record<string, string>) =>
    new Request(`${ORIGIN}/api/relay/status`, { headers })

  test("passes the bearer secret", () => {
    expect(
      checkOperator(status({ Authorization: `Bearer ${INGEST}` }), INGEST)
    ).toBeNull()
  })

  test("rejects a missing or wrong secret", () => {
    expect(checkOperator(status({}), INGEST)?.status).toBe(403)
    expect(
      checkOperator(status({ Authorization: "Bearer nope" }), INGEST)?.status
    ).toBe(403)
    expect(
      checkOperator(status({ Authorization: INGEST }), INGEST)?.status
    ).toBe(403)
  })
})

describe("checkClient", () => {
  const client = (
    ticket: string,
    { symbol = "BBCA", origin = ORIGIN, upgrade = "websocket" } = {}
  ) =>
    new Request(
      `${ORIGIN}/ws/trades?${new URLSearchParams({ symbol, since: "0", ticket })}`,
      { headers: { Origin: origin, Upgrade: upgrade } }
    )

  test("refuses a symbol that is not one, before reading the ticket", async () => {
    const ticket = await mintTicket(TICKET, BBCA, NOW)
    const response = await checkClient(
      client(ticket, { symbol: "bbca" }),
      TICKET,
      NOW
    )
    expect(response?.status).toBe(403)
  })

  test("passes a good ticket from the same origin", async () => {
    const ticket = await mintTicket(TICKET, BBCA, NOW)
    expect(await checkClient(client(ticket), TICKET, NOW)).toBeNull()
  })

  test("passes a market ticket on the market socket, and refuses a symbol's there", async () => {
    const market = await mintTicket(TICKET, MARKET, NOW)
    expect(
      await checkClient(client(market, { symbol: MARKET }), TICKET, NOW)
    ).toBeNull()
    const symbol = await mintTicket(TICKET, BBCA, NOW)
    const response = await checkClient(
      client(symbol, { symbol: MARKET }),
      TICKET,
      NOW
    )
    expect(response?.status).toBe(403)
  })

  test("rejects a wrong symbol", async () => {
    const ticket = await mintTicket(TICKET, Symbol.make("BBRI"), NOW)
    expect((await checkClient(client(ticket), TICKET, NOW))?.status).toBe(403)
  })

  test("rejects an expired ticket", async () => {
    const ticket = await mintTicket(TICKET, BBCA, NOW)
    expect(
      (await checkClient(client(ticket), TICKET, NOW + 60_001))?.status
    ).toBe(403)
  })

  test("rejects a tampered ticket", async () => {
    const ticket = await mintTicket(TICKET, BBCA, NOW)
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith("0") ? "1" : "0"}`
    expect((await checkClient(client(tampered), TICKET, NOW))?.status).toBe(403)
  })

  test("rejects a foreign origin", async () => {
    const ticket = await mintTicket(TICKET, BBCA, NOW)
    expect(
      (
        await checkClient(
          client(ticket, { origin: "https://evil.example" }),
          TICKET,
          NOW
        )
      )?.status
    ).toBe(403)
  })

  test("rejects a request that is not an upgrade", async () => {
    const ticket = await mintTicket(TICKET, BBCA, NOW)
    expect(
      (await checkClient(client(ticket, { upgrade: "h2c" }), TICKET, NOW))
        ?.status
    ).toBe(426)
  })
})
