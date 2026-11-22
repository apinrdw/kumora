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

test("the rule editor lists order flow kinds between book event and heavy side kinds", () => {
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  act(() => root.render(<AlertRules />))
  act(() => buttonNamed("Alert rules").click())
  const names = [...document.querySelectorAll("button")].map(
    (button) => button.textContent
  )
  const at = (name: string) => names.indexOf(name)
  expect(at("Wall moved")).toBeGreaterThan(-1)
  expect(
    ["Exhaustion", "Delta divergence", "Failed break", "Big orders"].map(at)
  ).toEqual([1, 2, 3, 4].map((i) => at("Wall moved") + i))
  act(() => buttonNamed("Exhaustion").click())
  expect(
    document.body.textContent,
    "an order flow kind ignores the minimum value"
  ).toContain(NOTE)
  act(() => root.unmount())
})
