// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { AlertRules } from "@/components/book-alerts/alerts-header"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
}))

const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent === name
  )!

const NOTE = "Minimum value applies only to book event kinds."

afterEach(() => {
  document.body.innerHTML = ""
})

test("the rule editor says when a picked kind ignores the minimum value", () => {
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  act(() => root.render(<AlertRules />))
  act(() => buttonNamed("Alert rules").click())
  act(() => buttonNamed("Eaten").click())
  expect(document.body.textContent, "book event kinds only").not.toContain(NOTE)
  act(() => buttonNamed("Big orders").click())
  expect(document.body.textContent).toContain(NOTE)
  act(() => root.unmount())
})
