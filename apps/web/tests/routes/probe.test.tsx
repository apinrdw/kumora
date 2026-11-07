import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import {
  Conflict,
  Forbidden,
  NotFound,
  WorkerEnv,
  makeRunServerEffect,
} from "@workspace/server"
import { Effect, Layer } from "effect"
import { renderToString } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { Route } from "@/routes/probe"
import { probeReport } from "@/server/probe"

// The server function is the network boundary. Each test answers it through
// the real bridge, so the loader sees exactly what Start would hand it.
const getProbeReport = vi.hoisted(() => vi.fn<() => Promise<unknown>>())
vi.mock("@/server/get-probe-report", () => ({ getProbeReport }))

const runServerEffect = makeRunServerEffect({
  isolate: Layer.empty,
  // The probe reads only the secret; the cast skips the unused ASSETS binding.
  workerEnv: Layer.succeed(WorkerEnv, { DEPLOY_PROBE_SECRET: "abc" } as never),
})

const answer = <A, E>(program: Effect.Effect<A, E, WorkerEnv>) =>
  getProbeReport.mockImplementation(() => runServerEffect(program))

// Server-renders /probe the way SSR's first paint does: load, then render.
async function firstPaint() {
  const root = createRootRoute()
  const probe = Route.update({
    id: "/probe",
    path: "/probe",
    getParentRoute: () => root,
  } as never)
  const router = createRouter({
    routeTree: root.addChildren([probe]),
    history: createMemoryHistory({ initialEntries: ["/probe"] }),
  })
  await router.load()
  return renderToString(<RouterProvider router={router} />)
}

describe("/probe page", () => {
  beforeEach(() => {
    getProbeReport.mockReset()
  })

  it("renders the probe report on the first paint", async () => {
    answer(probeReport(new Request("https://kumora.test/probe")))
    const html = await firstPaint()
    expect(html).toContain("https://kumora.test")
    // Published test vector: SHA-256("abc") starts ba7816bf8f01.
    expect(html).toContain("ba7816bf8f01")
  })

  it.each([
    new Forbidden({ message: "not on this stage" }),
    new Conflict({ message: "probe already running" }),
  ])("shows a $_tag in the error UI as that error", async (error) => {
    answer(Effect.fail(error))
    const html = await firstPaint()
    expect(html).toContain(error._tag)
    expect(html).toContain(error.message)
  })

  it("sends a NotFound to the route's not-found UI", async () => {
    answer(Effect.fail(new NotFound({ message: "no probe here" })))
    const html = await firstPaint()
    expect(html).toContain("Probe not found")
    expect(html).not.toContain("Unexpected error")
  })

  it("shows anything else as an unexpected error", async () => {
    answer(Effect.die("boom"))
    const html = await firstPaint()
    expect(html).toContain("Unexpected error")
    expect(html).not.toContain("boom")
  })
})
