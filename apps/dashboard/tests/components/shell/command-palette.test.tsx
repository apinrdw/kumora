// @vitest-environment happy-dom
// The Shell's command palette: Ctrl/⌘+K opens it everywhere but Market Live,
// and it runs the viewer's pages, account actions and stocks.
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { createAgent } from "@ui-sdk/react/agent"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { CommandPalette } from "@/components/shell/command-palette"
import type { Viewer } from "@/server/auth/gate"

const mocks = vi.hoisted(() => ({
  stockListFn: vi.fn<() => Promise<unknown>>(),
  signOut: vi.fn<() => Promise<void>>(),
}))

vi.mock("@/server/stocks/stocks.functions", () => ({
  stockListFn: () => mocks.stockListFn(),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: () => mocks.signOut() },
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
HTMLElement.prototype.showPopover = function () {}
HTMLElement.prototype.hidePopover = function () {}
Element.prototype.getAnimations = () => []
Element.prototype.scrollIntoView = function () {}
Element.prototype.checkVisibility = () => true

const viewer: Viewer = {
  name: "Ayu Lestari",
  email: "ayu@example.com",
  features: ["market-live", "stocks", "account"],
  impersonating: false,
}

const agent = createAgent()
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  mocks.stockListFn.mockResolvedValue([
    { code: "BBCA", issuerName: "Bank Central Asia Tbk." },
    { code: "TLKM", issuerName: "Telkom Indonesia (Persero) Tbk." },
  ])
  mocks.signOut.mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

async function renderAt(url: string, who: Viewer = viewer) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <>
          <CommandPalette viewer={who} />
          <Outlet />
        </>
      ),
    }),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  await router.load()
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root!.render(<RouterProvider router={router} />))
  return router
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)))

async function pressModK() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        bubbles: true,
      })
    )
  })
  await settle()
}

const search = () =>
  document.querySelector<HTMLInputElement>('[aria-label="Search commands"]')

const commandNames = () =>
  [...document.querySelectorAll('[data-slot="command-item"]')].map((item) =>
    item.textContent?.trim()
  )

async function type(text: string) {
  const input = search()!
  await act(async () => {
    input.focus()
    // React tracks the value it set; only the native setter makes this an edit.
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, text)
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  })
  await settle()
}

async function pressEnter() {
  await act(async () => {
    search()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    )
  })
  await settle()
}

test("Ctrl/⌘+K opens the viewer's pages and account actions, without stocks until something is typed", async () => {
  await renderAt("/")
  expect(search()).toBeNull()

  await pressModK()

  expect(search()).not.toBeNull()
  expect(commandNames()).toEqual([
    "Market Live",
    "Market Bubbles",
    "Order book radar",
    "Holder moves",
    "Account",
    "Sign out",
  ])
  expect(document.body.textContent).not.toContain("Accounts")
  expect(mocks.stockListFn).toHaveBeenCalledTimes(1)
})

test("typing a stock code and pressing Enter opens its stock page and closes the palette", async () => {
  const router = await renderAt("/")
  await pressModK()

  await type("bbca")
  expect(commandNames()[0]).toBe("BBCABank Central Asia Tbk.")

  await pressEnter()

  expect(router.state.location.pathname).toBe("/stocks/BBCA")
  expect(search()).toBeNull()
})

test("a page command navigates to its page", async () => {
  const router = await renderAt("/")
  await pressModK()

  await type("bubbles")
  await pressEnter()

  expect(router.state.location.pathname).toBe("/market-bubbles")
})

test("Sign out signs out and goes to sign-in, back to the page after", async () => {
  const router = await renderAt("/holder-moves")
  await pressModK()

  await type("sign out")
  await pressEnter()

  expect(mocks.signOut).toHaveBeenCalledTimes(1)
  expect(router.state.location.pathname).toBe("/sign-in")
  expect(router.state.location.search).toEqual({ redirect: "/holder-moves" })
})

test("on Market Live, Ctrl/⌘+K is left to its own palette; the trigger still opens this one", async () => {
  await renderAt("/market-live")

  await pressModK()
  expect(search()).toBeNull()

  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-slot="dialog-trigger"]'
  )!
  expect(trigger.textContent).toContain("Commands")
  expect(trigger.hasAttribute("aria-keyshortcuts")).toBe(false)
  await act(async () => trigger.click())
  await settle()
  expect(search()).not.toBeNull()
})

test("an account without the stocks feature sees no stocks and loads none", async () => {
  await renderAt("/", { ...viewer, features: ["market-live", "account"] })
  await pressModK()

  await type("bbca")

  expect(mocks.stockListFn).not.toHaveBeenCalled()
  expect(commandNames()).toEqual([])
  expect(document.body.textContent).toContain("No commands found.")
})

test("an agent can open the palette, search it and open a stock", async () => {
  const router = await renderAt("/")

  const opened = await agent.act({
    steps: [{ ref: "Commands", action: "press" }],
  })
  expect(opened.error?.message).toBeUndefined()
  await settle()

  const components = agent
    .snapshot()
    .filter((entry) => !entry.offPage && entry.component !== "more")
  expect(components.filter((entry) => !entry.label)).toEqual([])
  expect(components.map((entry) => entry.label)).toEqual(
    expect.arrayContaining(["Command palette", "Search commands"])
  )

  const ran = await agent.act({
    steps: [
      { ref: "Search commands", action: "setQuery", args: ["telkom"] },
      {
        ref: "Search commands",
        action: "run",
        args: ["TLKM Telkom Indonesia (Persero) Tbk."],
      },
    ],
  })
  expect(ran.error?.message).toBeUndefined()
  await settle()
  expect(router.state.location.pathname).toBe("/stocks/TLKM")
})
