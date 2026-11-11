import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { KDataTable } from "@/components/k/data-table"
import type { KDataTableProps } from "@/components/k/data-table"
import { EMPTY } from "@/components/k/empty-state"

type Row = { ticker: string; sector: string }

function headerHtml() {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <KDataTable<Row>
        label="Saham"
        columns={[
          { key: "ticker", label: "Kode", sortable: true },
          {
            key: "sector",
            label: "Sektor",
            description: "Klasifikasi IDX-IC",
          },
        ]}
        rows={[{ ticker: "BBCA", sector: "Keuangan" }]}
        getRowId={(r) => r.ticker}
      />
    </TooltipProvider>
  )
  return html.slice(html.indexOf("<thead"), html.indexOf("</thead>"))
}

describe("KDataTable column headers", () => {
  test("a non-sortable column with a description has a keyboard-reachable tooltip trigger", () => {
    const sectorHeader = headerHtml()
      .split("<th ")
      .find((th) => th.includes("Sektor"))
    expect(sectorHeader).toMatch(
      /<button[^>]*type="button"[^>]*>Sektor<\/button>/
    )
  })

  test("a sortable column with a description makes its sort button the tooltip trigger", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <KDataTable<Row>
          label="Saham"
          columns={[
            {
              key: "ticker",
              label: "Kode",
              sortable: true,
              description: "Kode saham IDX",
            },
          ]}
          rows={[{ ticker: "BBCA", sector: "Keuangan" }]}
          getRowId={(r) => r.ticker}
        />
      </TooltipProvider>
    )
    const [kode] = headers(html)
    expect(kode).toMatch(
      /<button[^>]*data-slot="tooltip-trigger"[^>]*>Kode<svg/
    )
  })

  test("a sortable column renders a sort button, and a plain column renders its bare label", () => {
    const html = renderToStaticMarkup(
      <KDataTable<Row>
        label="Saham"
        columns={[
          { key: "ticker", label: "Kode", sortable: true },
          { key: "sector", label: "Sektor" },
        ]}
        rows={[{ ticker: "BBCA", sector: "Keuangan" }]}
        getRowId={(r) => r.ticker}
      />
    )
    const [kode, sektor] = headers(html)
    expect(kode).toMatch(/<button[^>]*type="button"[^>]*>Kode<svg/)
    expect(sektor).not.toContain("<button")
    expect(sektor).toContain(">Sektor</th>")
  })
})

type Quote = {
  ticker: string
  name?: string
  change: number | null
  price: number | string
  flow: number
  volume: number
  status: string
  updated: string
}

const QUOTES: ReadonlyArray<Quote> = [
  {
    ticker: "BBCA",
    name: "Bank Central Asia",
    change: 1.35,
    price: 9275,
    flow: 128_600_000_000,
    volume: 12_400_000,
    status: "eod",
    updated: "2026-10-28T07:45:00Z",
  },
  {
    ticker: "TLKM",
    change: -0.5,
    price: "n/a",
    flow: -2_500_000,
    volume: 900,
    status: "bogus",
    updated: "2026-10-28T07:45:00Z",
  },
  {
    ticker: "ASII",
    change: null,
    price: 5000,
    flow: 0,
    volume: 1500,
    status: "live",
    updated: "2026-10-28T07:45:00Z",
  },
]

function tableHtml(props: Partial<KDataTableProps<Quote>> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <KDataTable<Quote>
        label="Kutipan"
        columns={[
          { key: "ticker", label: "Kode", cell: "ticker", sortable: true },
          { key: "change", label: "Ubah", cell: "pct", sortable: true },
          { key: "price", label: "Harga", cell: "idr" },
          { key: "flow", label: "Net flow", cell: "compactIdr" },
          { key: "volume", label: "Volume", cell: "shares" },
          { key: "status", label: "Status", cell: "status" },
          { key: "updated", label: "Per", cell: "asOf" },
        ]}
        rows={QUOTES}
        getRowId={(r) => r.ticker}
        {...props}
      />
    </TooltipProvider>
  )
}

function bodyRows(html: string) {
  const body = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"))
  return body.split("<tr").slice(1)
}

function cells(row: string) {
  return row.split("<td").slice(1)
}

function headers(html: string) {
  return html
    .slice(html.indexOf("<thead"), html.indexOf("</thead>"))
    .split("<th ")
    .slice(1)
}

function tickerOrder(html: string) {
  return bodyRows(html).map((r) => />([A-Z]{4})</.exec(r)?.[1])
}

describe("KDataTable cell kinds", () => {
  test("formats each built-in kind and falls back to a dash for missing or mistyped values", () => {
    const [bbca, tlkm, asii] = bodyRows(tableHtml()).map(cells)

    expect(bbca[0]).toContain("BBCA")
    expect(bbca[0]).toContain("Bank Central Asia")
    expect(bbca[1]).toContain("+1.35%")
    expect(bbca[1]).toContain("naik")
    expect(bbca[2]).toContain("Rp9,275")
    expect(bbca[3]).toMatch(/class="text-up"[^>]*>\+Rp128.6 B/)
    expect(bbca[4]).toContain("12.4 M shares")
    expect(bbca[5]).toContain("EOD")
    expect(bbca[6]).toContain("14:45 WIB")

    expect(tlkm[0]).not.toContain("Bank Central Asia")
    expect(tlkm[1]).toContain("turun")
    expect(tlkm[2]).toContain(">—<")
    expect(tlkm[3]).toMatch(/class="text-down"[^>]*>−Rp2.5 M/)
    expect(tlkm[4]).toContain("900 shares")
    expect(tlkm[5]).toContain(">—<")

    expect(asii[1]).toContain(">—<")
    expect(asii[3]).toContain("<span>Rp0</span>")
    expect(asii[5]).toContain("LIVE")
  })

  test("numeric kinds align right and text kinds align left", () => {
    const [bbca] = bodyRows(tableHtml()).map(cells)
    expect(bbca[0]).toContain("text-left")
    expect(bbca[2]).toContain("text-right")
  })

  test("columns without a kind render plain strings and numbers, and a custom cell renders its own node", () => {
    const html = renderToStaticMarkup(
      <KDataTable<{ id: string; n: number; obj: object; when: number }>
        label="Plain"
        columns={[
          { key: "id", label: "Id", align: "center" },
          { key: "n", label: "N" },
          { key: "obj", label: "Obj" },
          { key: "when", label: "Per", cell: "asOf" },
          { key: "id", label: "Custom", cell: (r) => <em>{r.id}!</em> },
        ]}
        rows={[{ id: "a", n: 7, obj: {}, when: 1 }]}
        getRowId={(r) => r.id}
      />
    )
    const [row] = bodyRows(html).map(cells)
    expect(row[0]).toContain("text-center")
    expect(row[0]).toContain(">a<")
    expect(row[1]).toContain(">7<")
    expect(row[2]).toContain(">—<")
    expect(row[3]).toContain(">—<")
    expect(row[4]).toContain("<em>a!</em>")
  })
})

describe("KDataTable sorting", () => {
  test("defaultSort reorders rows and marks the sorted header", () => {
    const html = tableHtml({ defaultSort: { key: "ticker", dir: "asc" } })
    expect(tickerOrder(html)).toEqual(["ASII", "BBCA", "TLKM"])
    const [kode, ubah, harga] = headers(html)
    expect(kode).toContain('aria-sort="ascending"')
    expect(ubah).toContain('aria-sort="none"')
    expect(harga).not.toContain("aria-sort")
  })

  test("a descending sort is announced as descending", () => {
    const html = tableHtml({ defaultSort: { key: "change", dir: "desc" } })
    expect(headers(html)[1]).toContain('aria-sort="descending"')
    expect(tickerOrder(html)).toEqual(["BBCA", "TLKM", "ASII"])
  })

  test("a controlled sort with onSort leaves row order to the caller", () => {
    const html = tableHtml({
      sort: { key: "ticker", dir: "asc" },
      onSort: () => {},
    })
    expect(tickerOrder(html)).toEqual(["BBCA", "TLKM", "ASII"])
    expect(headers(html)[0]).toContain('aria-sort="ascending"')
  })
})

describe("KDataTable rows and states", () => {
  test("clickable rows are focusable and the selected row is marked", () => {
    const html = tableHtml({ onRowClick: () => {}, selectedId: "TLKM" })
    const [bbca, tlkm] = bodyRows(html)
    expect(bbca).toContain('tabindex="0"')
    expect(bbca).not.toContain(`aria-selected="true"`)
    expect(tlkm).toContain('aria-selected="true"')
  })

  test("rows are not focusable without onRowClick", () => {
    expect(bodyRows(tableHtml())[0]).not.toContain("tabindex")
  })

  test("stickyFirst pins the first column header and cells, and the caption is screen-reader only", () => {
    const html = tableHtml({ stickyFirst: true, caption: "Daftar kutipan" })
    expect(html).toContain('<caption class="sr-only">Daftar kutipan</caption>')
    expect(headers(html)[0]).toContain("sticky")
    expect(headers(html)[1]).not.toContain("sticky")
    expect(cells(bodyRows(html)[0])[0]).toContain("sticky")
    expect(cells(bodyRows(html)[0])[1]).not.toContain("sticky")
  })

  test("comfortable density uses taller rows", () => {
    expect(bodyRows(tableHtml({ density: "comfortable" }))[0]).toContain("h-11")
    expect(bodyRows(tableHtml())[0]).toContain("h-9")
  })

  test("a ready table with no rows shows the no-result state across all columns", () => {
    const html = tableHtml({ rows: [] })
    expect(html).toContain(EMPTY["no-result"].title)
    expect(html).toContain('colSpan="7"')
  })

  test("a loading state replaces the body with a skeleton", () => {
    const html = tableHtml({ state: { status: "loading" } })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain("BBCA")
  })

  test("an error state is announced as an alert", () => {
    const html = tableHtml({
      state: { status: "error", message: "Gagal memuat" },
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain("Gagal memuat")
  })
})
