import { IconFilter } from "@tabler/icons-react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { KChip } from "@/components/k/chip"

const noop = () => {}

function buttons(html: string) {
  return html.match(/<button[^>]*>/g) ?? []
}

describe("KChip", () => {
  test("a reset chip is a plain dashed button, not a toggle", () => {
    const html = renderToStaticMarkup(
      <KChip reset onClick={noop} className="ml-2">
        Reset
      </KChip>
    )
    const [button] = buttons(html)
    expect(buttons(html)).toHaveLength(1)
    expect(button).toContain("border-dashed")
    expect(button).toContain("ml-2")
    expect(button).not.toContain("aria-pressed")
    expect(html).toContain("Reset")
  })

  test("a filter chip is a toggle that reflects its selection", () => {
    const off = renderToStaticMarkup(<KChip>Bank</KChip>)
    expect(off).toContain('aria-pressed="false"')
    const on = renderToStaticMarkup(<KChip selected>Bank</KChip>)
    expect(on).toContain('aria-pressed="true"')
  })

  test("shows the icon and match count when given", () => {
    const html = renderToStaticMarkup(
      <KChip icon={IconFilter} count={12}>
        Bank
      </KChip>
    )
    expect(html).toContain("tabler-icon-filter")
    expect(html).toMatch(/<span class="num[^"]*">12<\/span>/)
    expect(renderToStaticMarkup(<KChip>Bank</KChip>)).not.toContain(
      'class="num'
    )
  })

  test("a removable chip pairs the toggle with a sibling remove button that carries the class", () => {
    const html = renderToStaticMarkup(
      <KChip selected onRemove={noop} className="ml-2">
        Bank
      </KChip>
    )
    const [toggle, remove] = buttons(html)
    expect(buttons(html)).toHaveLength(2)
    expect(html).toMatch(/^<span class="inline-flex ml-2">/)
    expect(toggle).toContain("rounded-r-none")
    expect(toggle).not.toContain("ml-2")
    expect(remove).toContain('aria-label="Hapus filter"')
    expect(remove).toContain("bg-selected border-primary")
  })

  test("an unselected removable chip leaves the remove button unhighlighted", () => {
    const [, remove] = buttons(
      renderToStaticMarkup(<KChip onRemove={noop}>Bank</KChip>)
    )
    expect(remove).not.toContain("bg-selected border-primary")
  })

  test("a plain filter chip puts the class on the toggle itself", () => {
    const html = renderToStaticMarkup(<KChip className="ml-2">Bank</KChip>)
    expect(buttons(html)[0]).toContain("ml-2")
  })

  test("disabling a removable chip disables both buttons", () => {
    const html = renderToStaticMarkup(
      <KChip disabled onRemove={noop}>
        Bank
      </KChip>
    )
    for (const b of buttons(html)) expect(b).toContain("disabled")
  })
})
