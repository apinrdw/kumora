// The 60-second HMAC ticket that binds a /ws/trades socket to a symbol, or to the market.
import { isSymbol } from "@/domain/symbol-guard"

import { MARKET } from "./routes"
import type { TicketSubject } from "./routes"

const TTL_MS = 60_000
const encoder = new TextEncoder()

const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")

const unhex = (s: string) =>
  Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16))

export const isTicketSubject = (s: string | null): s is TicketSubject =>
  s === MARKET || isSymbol(s)

export const mintTicket = async (
  secret: string,
  symbol: TicketSubject,
  now: number
): Promise<string> => {
  const exp = now + TTL_MS
  const sig = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    encoder.encode(`${symbol}.${exp}`)
  )
  return `${exp}.${hex(sig)}`
}

export const verifyTicket = async (
  secret: string,
  ticket: string,
  symbol: TicketSubject,
  now: number
): Promise<boolean> => {
  const [exp, sig] = ticket.split(".")
  if (!exp || !sig || Number(exp) < now) return false
  return crypto.subtle.verify(
    "HMAC",
    await key(secret),
    unhex(sig),
    encoder.encode(`${symbol}.${exp}`)
  )
}

/** Constant-time comparison for the ingest secret. */
export const sameSecret = (a: string, b: string): boolean => {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
