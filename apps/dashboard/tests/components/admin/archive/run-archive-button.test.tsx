// @vitest-environment happy-dom
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"

import { RunArchiveButton } from "@/components/admin/archive/last-run-card"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const IMPORTING =
  "This archive's runs are still being copied into ArchiveDb. Try again to continue."

test("a refused start says the server's refusal", async () => {
  // A Conflict, as a server function's caller receives it.
  const start = () =>
    Promise.reject(
      Response.json({ error: "Conflict", message: IMPORTING }, { status: 409 })
    )
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <RunArchiveButton inProgress={false} start={start}>
          Run now
        </RunArchiveButton>
        <Outlet />
      </>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  await act(async () => {
    root.render(<RouterProvider router={router} />)
  })
  await act(async () => {
    container.querySelector("button")?.click()
  })
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      IMPORTING
    )
  )
  await act(async () => {
    root.unmount()
  })
})
