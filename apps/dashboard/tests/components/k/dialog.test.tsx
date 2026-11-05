import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { KDialog } from "@/components/k/dialog"
import type { KDialogProps } from "@/components/k/dialog"

const noop = () => {}

function inline(props: Partial<KDialogProps> = {}) {
  return renderToStaticMarkup(
    <KDialog
      inline
      open
      onOpenChange={noop}
      title="Hapus watchlist?"
      {...props}
    />
  )
}

describe("KDialog inline", () => {
  test("renders nothing while closed", () => {
    expect(inline({ open: false })).toBe("")
  })

  test("an info dialog is a labelled dialog with only a cancel action by default", () => {
    const html = inline({ description: "Ini tidak bisa dibatalkan." })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Hapus watchlist?"')
    expect(html).toMatch(/<h2[^>]*>Hapus watchlist\?<\/h2>/)
    expect(html).toMatch(/<p[^>]*>Ini tidak bisa dibatalkan\.<\/p>/)
    expect(html).toContain("text-info")
    expect(html).toContain(">Batal<")
    expect(html.match(/<button/g)).toHaveLength(1)
  })

  test("a confirm dialog is an alertdialog with a destructive confirm action", () => {
    const html = inline({
      kind: "confirm",
      confirmLabel: "Hapus",
      cancelLabel: "Tidak",
      onConfirm: noop,
    })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain("text-down")
    expect(html).toContain(">Tidak<")
    expect(html).toContain("Hapus")
    expect(html.match(/<button/g)).toHaveLength(2)
  })

  test("a warning dialog uses the warning tone and renders extra content", () => {
    const html = inline({
      kind: "warning",
      confirmLabel: "Lanjut",
      children: <div data-extra>Detail</div>,
    })
    expect(html).toContain('role="dialog"')
    expect(html).toContain("text-warning")
    expect(html).toContain("Detail")
    expect(html).not.toContain("<p ")
  })

  test("a loading confirm action is busy", () => {
    const html = inline({ confirmLabel: "Simpan", loading: true })
    expect(html).toContain('aria-busy="true"')
  })
})

describe("KDialog modal", () => {
  test("closed modal dialogs of every kind render nothing in place", () => {
    for (const kind of ["confirm", "info", "warning"] as const) {
      expect(
        renderToStaticMarkup(
          <KDialog open={false} onOpenChange={noop} kind={kind} title="T" />
        )
      ).toBe("")
    }
  })
})
