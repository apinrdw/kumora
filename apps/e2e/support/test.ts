import { test as base, type BrowserContext } from "@playwright/test"
import { randomInt } from "node:crypto"

import { DASHBOARD } from "./accounts"

// The dashboard's auth routes keep their per-IP limits in e2e (spec
// apinrdw/kumora#80), and every browser here shares one socket address. So
// each context sends its own client address in cf-connecting-ip, which
// `alchemy dev` passes through to Better Auth as Cloudflare would set it. Only
// requests to the dashboard carry it, never Turnstile's on Cloudflare.
// Addresses come from 198.18.0.0/15, the range set aside for tests.
export async function asOwnClient(context: BrowserContext) {
  const ip = `198.${randomInt(18, 20)}.${randomInt(256)}.${randomInt(1, 255)}`
  await context.route(`${DASHBOARD}/**`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "cf-connecting-ip": ip },
    })
  )
}

/**
 * Playwright's `test`, with each test's own `context` (and so `page`) sent
 * from its own client address. A context made with `browser.newContext()`
 * needs `asOwnClient` itself.
 */
export const test = base.extend({
  context: async ({ context }, provide) => {
    await asOwnClient(context)
    await provide(context)
  },
})

export { expect } from "@playwright/test"
