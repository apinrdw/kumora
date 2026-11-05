import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { pointReadout } from "@/components/k/charts/readout"

const data = [
  { label: "09.00", price: 9200 },
  { label: "09.15", price: 9250 },
]
const content = pointReadout(data, (p) => [
  { label: "Harga", value: String(p.price) },
])

describe("pointReadout", () => {
  test("shows the readout for the hovered point, titled by its label", () => {
    const html = renderToStaticMarkup(
      <>{content({ active: true, label: "09.15" })}</>
    )
    expect(html).toContain(">09.15</div>")
    expect(html).toContain(">Harga</span>")
    expect(html).toContain(">9250</span>")
    expect(html).not.toContain("9200")
  })

  test("shows nothing while the pointer is outside the plot", () => {
    expect(content({ active: false, label: "09.15" })).toBeNull()
  })

  test("shows nothing for a label that matches no point", () => {
    expect(content({ active: true, label: "10.00" })).toBeNull()
  })
})
