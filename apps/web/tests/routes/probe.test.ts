import { env } from "cloudflare:workers"
import { afterEach, describe, expect, test } from "vitest"

import { Route } from "@/routes/probe"

async function probe(url = "https://kumora.test/probe?x=1") {
  const handlers = Route.options.server?.handlers
  if (typeof handlers !== "object" || typeof handlers.GET !== "function")
    throw new Error("no GET handler")
  const response = await handlers.GET({ request: new Request(url) } as never)
  if (!(response instanceof Response)) throw new Error("no Response")
  return response
}

describe("GET /probe", () => {
  afterEach(() => {
    Reflect.deleteProperty(env, "DEPLOY_PROBE_SECRET")
  })

  test("answers the first 12 hex digits of the secret's SHA-256", async () => {
    // Published test vector: SHA-256("abc") starts ba7816bf8f01.
    Reflect.set(env, "DEPLOY_PROBE_SECRET", "abc")
    const body = await (await probe()).json()
    expect(body).toEqual({
      origin: "https://kumora.test",
      secretPresent: true,
      secretSha256Prefix: "ba7816bf8f01",
    })
  })

  test("never exposes the secret", async () => {
    const secret = "a-very-distinctive-secret"
    Reflect.set(env, "DEPLOY_PROBE_SECRET", secret)
    expect(await (await probe()).text()).not.toContain(secret)
  })

  test.each([undefined, ""])("reports %j as absent", async (value) => {
    Reflect.set(env, "DEPLOY_PROBE_SECRET", value)
    expect(await (await probe()).json()).toMatchObject({
      secretPresent: false,
      secretSha256Prefix: null,
    })
  })

  test("forbids caching, so verify never reads a stale answer", async () => {
    expect((await probe()).headers.get("cache-control")).toBe("no-store")
  })
})
