import type { BrowserContext, Response } from "@playwright/test"

const CLOUDFLARE = "challenges.cloudflare.com"

// The token Cloudflare's always-pass test keys hand out, which the Test
// stage's secret key accepts (apps/dashboard/alchemy.run.ts).
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"

// The part of Cloudflare's script API the forms use
// (apps/dashboard/src/components/auth/turnstile.tsx), passing at once.
const STUB_SCRIPT = `(() => {
  const callbacks = new Map()
  let next = 0
  const pass = (id) => setTimeout(() => callbacks.get(id)?.(${JSON.stringify(DUMMY_TOKEN)}))
  window.turnstile = {
    render: (_element, { callback }) => {
      const id = String(next++)
      callbacks.set(id, callback)
      pass(id)
      return id
    },
    reset: pass,
    remove: (id) => callbacks.delete(id),
  }
})()`

/**
 * Serves `context` a Turnstile script that passes at once, so its sign-up
 * and reset forms skip Cloudflare's 2 to 3 s check. Nothing else reaches
 * Cloudflare.
 */
export async function stubTurnstile(context: BrowserContext) {
  await context.route(`https://${CLOUDFLARE}/**`, (route) =>
    new URL(route.request().url()).pathname === "/turnstile/v0/api.js"
      ? route.fulfill({ contentType: "text/javascript", body: STUB_SCRIPT })
      : route.abort()
  )
}

/**
 * Whether a response came over the network from Turnstile's host. A routed
 * one, which Playwright fulfils itself, has no server address.
 */
export const fromCloudflare = async (response: Response) =>
  new URL(response.url()).hostname === CLOUDFLARE &&
  (await response.serverAddr()) !== null
