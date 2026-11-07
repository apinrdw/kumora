// @vitest-environment happy-dom
import { expect, test } from "vitest"

test("a DOM test can mount an element into the document", () => {
  const el = document.createElement("div")
  el.textContent = "mounted"
  document.body.append(el)
  expect(document.body.textContent).toBe("mounted")
})
