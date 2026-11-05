import { IconSearch } from "@tabler/icons-react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { KField, KInput } from "@/components/k/input"

function inputTag(html: string) {
  return /<input[^>]*>/.exec(html)?.[0] ?? ""
}

describe("KField", () => {
  test("labels the control and shows the hint under it", () => {
    const html = renderToStaticMarkup(
      <KField id="q" label="Cari" hint="Kode atau nama">
        <input id="q" />
      </KField>
    )
    expect(html).toMatch(/<label[^>]*for="q"[^>]*>Cari<\/label>/)
    expect(html).toContain('id="q-hint"')
    expect(html).toContain("Kode atau nama")
    expect(html).toContain("text-muted-foreground")
    expect(html).not.toContain("sr-only")
  })

  test("an error replaces the hint and is toned down", () => {
    const html = renderToStaticMarkup(
      <KField id="q" label="Cari" hint="Kode atau nama" error="Wajib diisi">
        <input id="q" />
      </KField>
    )
    expect(html).toContain("Wajib diisi")
    expect(html).not.toContain("Kode atau nama")
    expect(html).toMatch(/id="q-hint" class="[^"]*text-down/)
  })

  test("hideLabel keeps the label for screen readers only, and no message renders no hint", () => {
    const html = renderToStaticMarkup(
      <KField id="q" label="Cari" hideLabel>
        <input id="q" />
      </KField>
    )
    expect(html).toMatch(/<label[^>]*class="[^"]*sr-only/)
    expect(html).not.toContain("q-hint")
  })
})

describe("KInput", () => {
  test("uses the given id and links the hint for assistive tech", () => {
    const html = renderToStaticMarkup(
      <KInput id="ticker" label="Ticker" hint="mis. BBCA" placeholder="BBCA" />
    )
    const input = inputTag(html)
    expect(input).toContain('id="ticker"')
    expect(input).toContain('aria-describedby="ticker-hint"')
    expect(input).toContain('placeholder="BBCA"')
    expect(input).not.toContain("aria-invalid=")
    expect(input).toContain("h-9")
  })

  test("generates an id that the label points at when none is given", () => {
    const html = renderToStaticMarkup(<KInput label="Ticker" />)
    const id = /<input[^>]*id="([^"]+)"/.exec(html)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`for="${id}"`)
    expect(inputTag(html)).not.toContain("aria-describedby")
  })

  test("an error marks the input invalid and describes it", () => {
    const input = inputTag(
      renderToStaticMarkup(
        <KInput id="t" label="Ticker" error="Tidak dikenal" />
      )
    )
    expect(input).toContain('aria-invalid="true"')
    expect(input).toContain('aria-describedby="t-hint"')
  })

  test("the md size is taller", () => {
    expect(
      inputTag(renderToStaticMarkup(<KInput label="Ticker" size="md" />))
    ).toContain("h-10")
  })

  test("a leading icon and a shortcut hint pad the input on each side", () => {
    const html = renderToStaticMarkup(
      <KInput label="Cari" icon={IconSearch} shortcut="/" />
    )
    expect(html).toContain("tabler-icon-search")
    expect(html).toMatch(/<kbd[^>]*>\/<\/kbd>/)
    const input = inputTag(html)
    expect(input).toContain("pl-9")
    expect(input).toContain("pr-9")

    const plain = inputTag(renderToStaticMarkup(<KInput label="Cari" />))
    expect(plain).not.toContain("pl-9")
    expect(plain).not.toContain("pr-9")
  })
})
