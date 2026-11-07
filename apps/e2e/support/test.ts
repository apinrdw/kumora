import {
  test as base,
  type Browser,
  type BrowserContext,
} from "@playwright/test"
import { randomInt } from "node:crypto"

import { DASHBOARD } from "./accounts"

// The dashboard's auth routes keep their per-IP limits in e2e (spec
// apinrdw/kumora#80), and every browser here shares one socket address. So
// each context sends its own client address in cf-connecting-ip, which
// `alchemy dev` passes through to Better Auth as Cloudflare would set it. Only
// requests to the dashboard carry it, never Turnstile's on Cloudflare.
// Addresses come from 198.18.0.0/15, the range set aside for tests.
// Better Auth reads the header as CLIENT_IP_HEADER in
// apps/dashboard/src/server/auth/options.ts.
const CLIENT_IP_HEADER = "cf-connecting-ip"

async function asOwnClient(context: BrowserContext) {
  const ip = `198.${randomInt(18, 20)}.${randomInt(256)}.${randomInt(1, 255)}`
  await context.route(`${DASHBOARD}/**`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), [CLIENT_IP_HEADER]: ip },
    })
  )
  return context
}

/** `browser.newContext()`, sending from its own client address. */
export const newClientContext = async (browser: Browser) =>
  asOwnClient(await browser.newContext())

/**
 * Playwright's `test`, with each test's own `context` (and so `page`) sent
 * from its own client address. Make other contexts with `newClientContext`.
 */
export const test = base.extend({
  context: async ({ context }, provide) => {
    await provide(await asOwnClient(context))
  },
})

export { expect } from "@playwright/test"
