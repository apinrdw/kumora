// The dashboard Worker's fetch entry on Production, whose old workers.dev
// host must send every request to the Stage URL. e2e can't reach a second
// host, so this seam covers it.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

import type { RedirectEnv } from "@/server/base-redirect"

// The entry's Durable Object and Workflow classes extend these at import.
vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => {},
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}))
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class {} }))
// Start would answer every request the redirects let through.
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: () => new Response("start") },
}))

// The entry's modules name Workers types this project typechecks without
// (tests/tsconfig.json), so a non-literal specifier keeps tsc out of them and
// the entry's type is written here.
const ENTRY = "@/worker"
const { default: worker } = (await import(ENTRY)) as {
  readonly default: {
    readonly fetch: (
      request: Request,
      env: RedirectEnv
    ) => Response | Promise<Response>
  }
}

const PRODUCTION: RedirectEnv = {
  DASHBOARD_URL: "https://kumora.pusat.ai/dashboard",
  REDIRECT_TO_STAGE_URL: "on",
}
const OLD_HOST = "https://kumora-dashboard.kumora.workers.dev"

const fetchEntry = (url: string) =>
  Effect.sync(() => worker.fetch(new Request(url), PRODUCTION)).pipe(
    Effect.flatMap((answer) =>
      answer instanceof Response
        ? Effect.succeed(answer)
        : Effect.promise(() => answer)
    )
  )

describe("the dashboard Worker on Production", () => {
  it.effect.each([
    ["/", "https://kumora.pusat.ai/dashboard/"],
    ["/stocks/BBCA", "https://kumora.pusat.ai/dashboard/stocks/BBCA"],
    ["/dashboard", "https://kumora.pusat.ai/dashboard"],
    [
      "/dashboard/stocks/BBCA?tab=brokers",
      "https://kumora.pusat.ai/dashboard/stocks/BBCA?tab=brokers",
    ],
    [
      "/?redirect=%2Fadmin",
      "https://kumora.pusat.ai/dashboard/?redirect=%2Fadmin",
    ],
  ] as const)("301s %s on workers.dev to %s", ([path, location]) =>
    Effect.gen(function* () {
      const response = yield* fetchEntry(`${OLD_HOST}${path}`)
      assert.strictEqual(response.status, 301)
      assert.strictEqual(response.headers.get("Location"), location)
    })
  )

  // A binding that is not a Stage URL is a broken deploy.
  it("dies on a DASHBOARD_URL that is not a Stage URL", () => {
    assert.throws(() =>
      worker.fetch(new Request(`${OLD_HOST}/stocks/BBCA`), {
        ...PRODUCTION,
        DASHBOARD_URL: "https://kumora.pusat.ai/dashboard/",
      })
    )
  })

  it.effect("serves a request on the Stage URL's own host", () =>
    Effect.gen(function* () {
      const response = yield* fetchEntry(
        "https://kumora.pusat.ai/dashboard/stocks/BBCA"
      )
      assert.strictEqual(response.status, 200)
      assert.strictEqual(yield* Effect.promise(() => response.text()), "start")
    })
  )
})
