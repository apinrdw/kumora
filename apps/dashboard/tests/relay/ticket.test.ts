import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { MARKET } from "@/relay/routes"
import { mintTicket, sameSecret, verifyTicket } from "@/relay/ticket"

const SECRET = "ticket-secret"
const NOW = 1_800_000_000_000
const BBCA = Symbol.make("BBCA")

describe("relay ticket", () => {
  test("verifies for its symbol within 60 s", async () => {
    const ticket = await mintTicket(SECRET, BBCA, NOW)
    expect(await verifyTicket(SECRET, ticket, BBCA, NOW + 60_000)).toBe(true)
  })

  test("is shaped <exp>.<hex HMAC>", async () => {
    const ticket = await mintTicket(SECRET, BBCA, NOW)
    expect(ticket).toMatch(new RegExp(`^${NOW + 60_000}\\.[0-9a-f]{64}$`))
  })

  test("rejects a wrong symbol", async () => {
    const ticket = await mintTicket(SECRET, BBCA, NOW)
    expect(await verifyTicket(SECRET, ticket, Symbol.make("BBRI"), NOW)).toBe(
      false
    )
  })

  test("a market ticket opens only the market, and a symbol's never does", async () => {
    const market = await mintTicket(SECRET, MARKET, NOW)
    expect(await verifyTicket(SECRET, market, MARKET, NOW)).toBe(true)
    expect(await verifyTicket(SECRET, market, BBCA, NOW)).toBe(false)
    const symbol = await mintTicket(SECRET, BBCA, NOW)
    expect(await verifyTicket(SECRET, symbol, MARKET, NOW)).toBe(false)
  })

  test("rejects an expired ticket", async () => {
    const ticket = await mintTicket(SECRET, BBCA, NOW)
    expect(await verifyTicket(SECRET, ticket, BBCA, NOW + 60_001)).toBe(false)
  })

  test("rejects a tampered signature, a pushed-out expiry, and a wrong secret", async () => {
    const ticket = await mintTicket(SECRET, BBCA, NOW)
    const [exp, sig] = ticket.split(".")
    const flipped = `${sig?.startsWith("0") ? "1" : "0"}${sig?.slice(1)}`
    expect(await verifyTicket(SECRET, `${exp}.${flipped}`, BBCA, NOW)).toBe(
      false
    )
    expect(
      await verifyTicket(SECRET, `${Number(exp) + 1}.${sig}`, BBCA, NOW)
    ).toBe(false)
    expect(await verifyTicket("other", ticket, BBCA, NOW)).toBe(false)
  })

  test("rejects garbage", async () => {
    for (const ticket of ["", ".", "abc", "abc.def", `${NOW + 1000}.zz`])
      expect(await verifyTicket(SECRET, ticket, BBCA, NOW)).toBe(false)
  })
})

describe("sameSecret", () => {
  test("matches only the identical string", () => {
    expect(sameSecret("abc", "abc")).toBe(true)
    expect(sameSecret("abc", "abd")).toBe(false)
    expect(sameSecret("abc", "abcd")).toBe(false)
    expect(sameSecret("", "abc")).toBe(false)
  })
})
