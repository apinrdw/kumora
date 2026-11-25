// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, test } from "vitest"

import { BoundedRows, ROWS_SHOWN } from "@/components/k/bounded-rows"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const numbers = (count: number) => Array.from({ length: count }, (_, at) => at)

const list = (count: number, key?: string, step?: number) => (
  <ul>
    <BoundedRows
      key={key}
      rows={numbers(count)}
      step={step}
      more={(control) => <li data-more>{control}</li>}
    >
      {(row) => <li key={row}>{row}</li>}
    </BoundedRows>
  </ul>
)

const container = document.createElement("div")
document.body.append(container)
const root = createRoot(container)
afterEach(() => act(() => root.render(null)))

const items = () => container.querySelectorAll("li:not([data-more])").length
const more = () => container.querySelector("[data-more]")

describe("BoundedRows", () => {
  test("renders a list within its bound whole, with nothing to show more of", async () => {
    await act(() => root.render(list(ROWS_SHOWN)))
    expect(items()).toBe(ROWS_SHOWN)
    expect(more()).toBeNull()
  })

  test("server-renders the first rows of a longer list, and how many it holds", () => {
    const html = renderToStaticMarkup(list(8_000))
    expect(html.match(/<li>/g)).toHaveLength(ROWS_SHOWN)
    expect(html).toContain(`${ROWS_SHOWN} of 8000 shown`)
  })

  test("shows as many more on each click, the last click the rest", async () => {
    await act(() => root.render(list(2 * ROWS_SHOWN + 50)))
    expect(items()).toBe(ROWS_SHOWN)
    expect(more()?.textContent).toBe(
      `${ROWS_SHOWN} of ${2 * ROWS_SHOWN + 50} shown · Show ${ROWS_SHOWN} more`
    )
    await act(() => more()?.querySelector("button")?.click())
    expect(items()).toBe(2 * ROWS_SHOWN)
    expect(more()?.textContent).toBe(
      `${2 * ROWS_SHOWN} of ${2 * ROWS_SHOWN + 50} shown · Show 50 more`
    )
    await act(() => more()?.querySelector("button")?.click())
    expect(items()).toBe(2 * ROWS_SHOWN + 50)
    expect(more()).toBeNull()
  })

  test("starts over when its key changes", async () => {
    await act(() => root.render(list(30, "a", 10)))
    await act(() => more()?.querySelector("button")?.click())
    expect(items()).toBe(20)
    await act(() => root.render(list(30, "b", 10)))
    expect(items()).toBe(10)
  })
})
