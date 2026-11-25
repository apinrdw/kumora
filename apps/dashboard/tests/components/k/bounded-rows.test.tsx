// @vitest-environment happy-dom
import { act } from "react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { BoundedRows, ROWS_SHOWN } from "@/components/k/bounded-rows"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const numbers = (count: number) => Array.from({ length: count }, (_, at) => at)

const list = (count: number, bound?: number) => (
  <ul>
    <BoundedRows rows={numbers(count)} bound={bound}>
      {(row) => <li key={row}>{row}</li>}
    </BoundedRows>
  </ul>
)

const items = (html: string) => html.match(/<li>/g)?.length ?? 0

// The page as a browser gets it: the server's HTML, then hydrated.
const hydrated = async (count: number, bound?: number) => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(list(count, bound))
  document.body.append(container)
  const root = await act(() => hydrateRoot(container, list(count, bound)))
  const shown = container.querySelectorAll("li").length
  await act(() => root.unmount())
  container.remove()
  return shown
}

describe("BoundedRows", () => {
  test("server-renders the first rows of a longer list", () => {
    expect(items(renderToString(list(8_000)))).toBe(ROWS_SHOWN)
  })

  test("server-renders as many rows as its bound", () => {
    expect(items(renderToString(list(8_000, 60)))).toBe(60)
  })

  test("renders every row of a longer list once the page hydrates", async () => {
    expect(await hydrated(2 * ROWS_SHOWN + 50)).toBe(2 * ROWS_SHOWN + 50)
  })

  test("renders a list within its bound whole on both sides", async () => {
    expect(items(renderToString(list(ROWS_SHOWN)))).toBe(ROWS_SHOWN)
    expect(await hydrated(ROWS_SHOWN)).toBe(ROWS_SHOWN)
  })
})
