import { IconStar } from "@tabler/icons-react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { EMPTY, KEmptyState, KStateBody } from "@/components/k/empty-state"
import type { KDataState } from "@/components/k/empty-state"

const noop = () => {}

describe("KEmptyState", () => {
  test("defaults to the no-result copy inside a dashed frame", () => {
    const html = renderToStaticMarkup(<KEmptyState />)
    expect(html).toContain(EMPTY["no-result"].title)
    expect(html).toContain(EMPTY["no-result"].description)
    expect(html).toContain("border-dashed")
    expect(html).toContain("max-w-[480px]")
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain("<button")
  })

  test("custom title, description, and icon override the kind's copy", () => {
    const html = renderToStaticMarkup(
      <KEmptyState
        kind="no-watchlist"
        icon={IconStar}
        title="Kosong"
        description="Tambah sesuatu."
      />
    )
    expect(html).toContain("Kosong")
    expect(html).toContain("Tambah sesuatu.")
    expect(html).not.toContain(EMPTY["no-watchlist"].title)
    expect(html).toContain("tabler-icon-star")
    expect(html).not.toContain("tabler-icon-plus")
  })

  test("the error kind is announced as an alert with a down border", () => {
    const html = renderToStaticMarkup(<KEmptyState kind="error" />)
    expect(html).toContain('role="alert"')
    expect(html).toContain("border-down")
    expect(html).toContain(EMPTY.error.title)
  })

  test("bare drops the frame width limit and border", () => {
    const html = renderToStaticMarkup(<KEmptyState bare />)
    expect(html).toContain("max-w-none border-0")
  })

  test("renders primary and secondary actions only when given", () => {
    const primary = renderToStaticMarkup(
      <KEmptyState action={{ label: "Tambah ticker", onClick: noop }} />
    )
    expect(primary).toContain("Tambah ticker")
    expect(primary.match(/<button/g)).toHaveLength(1)

    const both = renderToStaticMarkup(
      <KEmptyState
        action={{ label: "Tambah ticker", onClick: noop }}
        secondaryAction={{ label: "Pelajari", onClick: noop }}
      />
    )
    expect(both).toContain("Pelajari")
    expect(both.match(/<button/g)).toHaveLength(2)

    const secondaryOnly = renderToStaticMarkup(
      <KEmptyState secondaryAction={{ label: "Pelajari", onClick: noop }} />
    )
    expect(secondaryOnly.match(/<button/g)).toHaveLength(1)
    expect(secondaryOnly).toContain("Pelajari")
  })
})

function body(state: Exclude<KDataState, { status: "ready" }>) {
  return renderToStaticMarkup(
    <KStateBody state={state} skeleton={<i data-skeleton />} />
  )
}

describe("KStateBody", () => {
  test("loading renders the caller's skeleton", () => {
    expect(body({ status: "loading" })).toBe('<i data-skeleton="true"></i>')
  })

  test("empty defaults to no-data and passes custom copy through", () => {
    expect(body({ status: "empty" })).toContain(EMPTY["no-data"].title)
    const custom = body({ status: "empty", kind: "no-watchlist", title: "X" })
    expect(custom).toContain(">X<")
    expect(custom).toContain(EMPTY["no-watchlist"].description)
  })

  test("restricted renders the no-access state", () => {
    expect(body({ status: "restricted" })).toContain(EMPTY["no-access"].title)
  })

  test("error shows the message and a retry action only with onRetry", () => {
    const plain = body({ status: "error", message: "Gagal" })
    expect(plain).toContain('role="alert"')
    expect(plain).toContain("Gagal")
    expect(plain).not.toContain("Coba lagi</button>")

    const retry = body({ status: "error", onRetry: noop })
    expect(retry).toContain(EMPTY.error.title)
    expect(retry).toMatch(/<button[^>]*>Coba lagi<\/button>/)
  })
})
