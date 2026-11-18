// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { SoundToggle } from "@/components/market-live/sound-toggle"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

// The toggle as a fresh page load renders it; returns its button and the
// unmount.
const mount = () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<SoundToggle />))
  const button = () => host.querySelector("button")!
  return {
    button,
    click: () => act(() => button().click()),
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

test("the speaker toggle is off by default", () => {
  const toggle = mount()
  expect(toggle.button().getAttribute("aria-pressed")).toBe("false")
  toggle.unmount()
})

test("turning sound on is remembered after a reload", () => {
  const first = mount()
  first.click()
  expect(first.button().getAttribute("aria-pressed")).toBe("true")
  first.unmount()

  const reloaded = mount()
  expect(reloaded.button().getAttribute("aria-pressed")).toBe("true")
  reloaded.click()
  reloaded.unmount()

  const again = mount()
  expect(again.button().getAttribute("aria-pressed")).toBe("false")
  again.unmount()
})

test("with storage blocked, the toggle starts off and still turns on", () => {
  // Each read and write fails, as a blocked localStorage does.
  vi.spyOn(window, "localStorage", "get").mockReturnValue(
    undefined as unknown as Storage
  )
  const toggle = mount()
  expect(toggle.button().getAttribute("aria-pressed")).toBe("false")
  toggle.click()
  expect(toggle.button().getAttribute("aria-pressed")).toBe("true")
  toggle.unmount()
})
