import { beforeEach, describe, expect, test, vi } from "vitest"

import { readChunk } from "@/ownership/csv"
import type { Dataset, Row } from "@/ownership/csv"
import { flagRows } from "@/ownership/flags"
import type { RowFlag } from "@/ownership/flags"
import { holderKey } from "@/ownership/holder-key"
import { upsertFlags } from "@/ownership/store"

import { fixture, ownershipWorker, sha256 } from "../support/ownership"

let app: ReturnType<typeof ownershipWorker>

beforeEach(() => {
  app = ownershipWorker()
})

const post = async (dataset: string, asOf: string, csv: string) => {
  const response = await app.postCsv(csv, { asOf, dataset })
  expect(response.status).toBe(202)
  const { fileId } = (await response.json()) as { fileId: string }
  await app.load.runAll()
  return fileId
}

const flagsOf = async (fileId: string) =>
  (
    await app.db
      .prepare(
        "SELECT row_no, rule, detail FROM row_flags WHERE file_id = ? ORDER BY row_no, rule"
      )
      .bind(fileId)
      .all<{ row_no: number; rule: string; detail: string }>()
  ).results

const fileStatus = async (fileId: string) =>
  (
    await app.db
      .prepare("SELECT status FROM ownership_files WHERE id = ?")
      .bind(fileId)
      .first<{ status: string }>()
  )?.status

const holderRow = (
  holderNo: number | null,
  shares: number | null,
  combined: number | null,
  symbol = "AADI"
): Row => ({
  symbol,
  holder_no: holderNo,
  shares,
  combined_shares: combined,
})

/** Rows in file order, numbered as the store numbers them. */
const flagged = (dataset: Dataset, rows: ReadonlyArray<Row>) =>
  flagRows(
    dataset,
    rows.map((row, index) => ({ ...row, row_no: index + 1 }))
  )

describe("line_sum", () => {
  const lineSums = (rows: ReadonlyArray<Row>) =>
    flagged("lima-persen", rows).filter((f) => f.rule === "line_sum")

  test("flags the first line of a holder whose shares miss the combined total", () => {
    expect(
      lineSums([
        holderRow(1, 10, 10),
        holderRow(2, 5, 16),
        holderRow(2, 10, null),
      ])
    ).toEqual([
      { rowNo: 2, rule: "line_sum", detail: "lines sum to 15, not 16" },
    ])
  })

  test("a holder that sums has no flag", () => {
    expect(lineSums([holderRow(1, 5, 15), holderRow(1, 10, null)])).toEqual([])
  })

  test("does not judge a holder with an empty figure", () => {
    expect(
      lineSums([
        holderRow(1, 5, 15),
        holderRow(1, null, null),
        holderRow(2, 5, null),
      ])
    ).toEqual([])
  })

  test("the same holder number under another symbol is another holder", () => {
    expect(
      lineSums([holderRow(1, 5, 5, "AADI"), holderRow(1, 7, 7, "BBCA")])
    ).toEqual([])
  })
})

const breakdownRow = (
  shares: number | null,
  total: number | null,
  symbol = "BBCA"
): Row => ({ symbol, shares, total_scripless: total })

describe.each(["tipe", "klasifikasi"] as const)(
  "category_sum in %s",
  (dataset) => {
    const categorySums = (rows: ReadonlyArray<Row>) =>
      flagged(dataset, rows).filter((f) => f.rule === "category_sum")

    test("flags a symbol's first row when its categories miss the total", () => {
      expect(
        categorySums([
          breakdownRow(10, 10, "AADI"),
          breakdownRow(4, 10),
          breakdownRow(5, 10),
        ])
      ).toEqual([
        {
          rowNo: 2,
          rule: "category_sum",
          detail: "categories sum to 9, not 10",
        },
      ])
    })

    test("a category published empty adds nothing", () => {
      expect(
        categorySums([
          breakdownRow(4, 10),
          breakdownRow(null, 10),
          breakdownRow(6, 10),
        ])
      ).toEqual([])
    })

    test("a row giving another total fails the sum", () => {
      expect(categorySums([breakdownRow(4, 10), breakdownRow(6, 11)])).toEqual([
        {
          rowNo: 1,
          rule: "category_sum",
          detail: "categories sum to 10, not 11",
        },
      ])
    })

    test("a symbol with no total has nothing to check", () => {
      expect(categorySums([breakdownRow(4, null)])).toEqual([])
    })
  }
)

describe("duplicate_key", () => {
  const duplicates = (dataset: Dataset, rows: ReadonlyArray<Row>) =>
    flagged(dataset, rows)
      .filter((f) => f.rule === "duplicate_key")
      .map((f) => f.rowNo)

  const onePercent: Row = {
    as_of: "2026-04-30",
    symbol: "BBCA",
    investor_name: "PT X",
    classification: "Bank",
    local_foreign: "L",
    nationality: null,
    domicile: "INDONESIA",
  }

  test("flags each later repeat in the 1%, and stores the first alone", () => {
    expect(
      duplicates("satu-persen", [onePercent, onePercent, onePercent])
    ).toEqual([2, 3])
  })

  test("any one key column differing is not a repeat", () => {
    expect(
      duplicates("satu-persen", [
        onePercent,
        { ...onePercent, domicile: null },
        { ...onePercent, investor_name: "PT Y" },
      ])
    ).toEqual([])
  })

  test("tipe keys on side, category and band, not the figures", () => {
    const row: Row = {
      as_of: "2026-09-30",
      symbol: "BBCA",
      side: "local",
      category: "CP",
      band: "below_5",
      shares: 1,
    }
    expect(
      duplicates("tipe", [
        row,
        { ...row, band: "at_or_above_5" },
        { ...row, shares: 2 },
      ])
    ).toEqual([3])
  })

  test("klasifikasi takes categories as published, so BANK and Bank differ", () => {
    const row: Row = {
      as_of: "2026-09-30",
      symbol: "BBCA",
      side: null,
      category: "BANK",
    }
    expect(
      duplicates("klasifikasi", [row, { ...row, category: "Bank" }, row])
    ).toEqual([3])
  })

  test("the 5% file has no such check", () => {
    const line = holderRow(1, 5, 5)
    expect(duplicates("lima-persen", [line, line])).toEqual([])
  })
})

describe("empty_value", () => {
  const empties = (dataset: Dataset, rows: ReadonlyArray<Row>) =>
    flagged(dataset, rows).filter((f) => f.rule === "empty_value")

  test("flags a 5% line with empty shares, on any line of a holder", () => {
    expect(
      empties("lima-persen", [holderRow(1, 5, 15), holderRow(1, null, null)])
    ).toEqual([{ rowNo: 2, rule: "empty_value", detail: "shares is empty" }])
  })

  test("flags a holder's first line with no combined total", () => {
    expect(
      empties("lima-persen", [holderRow(1, 5, null), holderRow(1, 10, null)])
    ).toEqual([
      { rowNo: 1, rule: "empty_value", detail: "combined_shares is empty" },
    ])
  })

  test("a continuation line has no combined total to miss, and zero is not empty", () => {
    expect(
      empties("lima-persen", [holderRow(1, 0, 10), holderRow(1, 10, null)])
    ).toEqual([])
  })

  test("a row missing both is one flag naming both", () => {
    expect(empties("lima-persen", [holderRow(1, null, null)])).toEqual([
      {
        rowNo: 1,
        rule: "empty_value",
        detail: "shares, combined_shares is empty",
      },
    ])
  })

  test("flags a 1% line with an empty total, not an empty scrip", () => {
    expect(
      empties("satu-persen", [
        { scripless: 1, scrip: null, total: 1 },
        { scripless: 1, scrip: 0, total: null },
      ])
    ).toEqual([{ rowNo: 2, rule: "empty_value", detail: "total is empty" }])
  })

  test("a breakdown category published empty is not an emptied count", () => {
    expect(empties("tipe", [breakdownRow(null, 10)])).toEqual([])
  })
})

describe("a file whose rows fail a check", () => {
  test.each([
    ["2026-02-27", "MAYA"],
    ["2026-03-31", "SMRA"],
  ])("1%% file %s raises exactly one row_sum, on %s", async (asOf, symbol) => {
    const csv = fixture(`satu-persen-${asOf}.csv`)
    const fileId = await post("satu-persen", asOf, csv)

    const rowSums = (await flagsOf(fileId)).filter((f) => f.rule === "row_sum")
    expect(rowSums).toHaveLength(1)

    const line = await app.db
      .prepare(
        "SELECT symbol, scripless, scrip, total FROM holding_lines_1 WHERE file_id = ? AND row_no = ?"
      )
      .bind(fileId, rowSums[0]?.row_no)
      .first<{
        symbol: string
        scripless: number
        scrip: number
        total: number
      }>()
    expect(line?.symbol).toBe(symbol)
    expect(rowSums[0]?.detail).toBe(
      `${line?.scripless} + ${line?.scrip} is not ${line?.total}`
    )
    expect(await fileStatus(fileId)).toBe("loaded")
  })

  test("the flagged row keeps its figures as published", async () => {
    const asOf = "2026-02-27"
    const csv = fixture(`satu-persen-${asOf}.csv`)
    const fileId = await post("satu-persen", asOf, csv)
    const [flag] = await flagsOf(fileId)

    const rowNo = flag?.row_no ?? 0
    const [published] = readChunk("satu-persen", csv, rowNo - 1, rowNo)
    const stored = await app.db
      .prepare(
        "SELECT scripless, scrip, total, percent FROM holding_lines_1 WHERE file_id = ? AND row_no = ?"
      )
      .bind(fileId, flag?.row_no)
      .first()
    expect(stored).toEqual({
      scripless: published?.scripless,
      scrip: published?.scrip,
      total: published?.total,
      percent: published?.percent,
    })
  })

  test("a clean file raises no flag", async () => {
    const asOf = "2026-09-30"
    const fileId = await post(
      "klasifikasi",
      asOf,
      fixture(`klasifikasi-${asOf}.csv`)
    )
    expect(await flagsOf(fileId)).toEqual([])
  })

  test("many flags fit D1's bound parameter limit, and a rerun adds none", async () => {
    const asOf = "2026-02-27"
    const [header = "", line = ""] = fixture(`satu-persen-${asOf}.csv`).split(
      "\n"
    )
    const csv = `${[header, ...Array.from({ length: 60 }, () => line)].join("\n")}\n`
    const fileId = await post("satu-persen", asOf, csv)
    const flags = await flagsOf(fileId)
    expect(flags.filter((f) => f.rule === "duplicate_key")).toHaveLength(59)

    await upsertFlags(app.db, fileId, [
      { rowNo: 2, rule: "duplicate_key", detail: "repeats row 1" },
    ])
    expect(await flagsOf(fileId)).toEqual(flags)
  })
})

describe("a file of many symbols", () => {
  const SYMBOLS = [
    ...Array.from({ length: 28 }, (_, i) => `S${String(i).padStart(2, "0")}`),
    "TRUE",
    "O'B",
  ]
  const ROWS_PER_SYMBOL = 6
  const SYMBOLS_PER_READ = 10
  const ASOF = "2025-11-28"

  /** Symbols interleave, so a symbol's rows are far apart. The last round repeats the first. */
  const interleavedCsv = () => {
    const rounds = [0, 1, 2, 3, 4, 0]
    const lines = rounds.flatMap((band) =>
      SYMBOLS.map((symbol) => {
        const published = symbol === "TRUE" ? 7 : ROWS_PER_SYMBOL
        return `${ASOF},${symbol},100,,CP,band_${band},1,${published}`
      })
    )
    const header =
      "as_of,symbol,number_of_shares,side,category,band,shares,total_scripless"
    return `${[header, ...lines].join("\n")}\n`
  }

  const repeats = SYMBOLS.map((_, i) => ({
    row_no: 5 * SYMBOLS.length + i + 1,
    rule: "duplicate_key",
    detail: `repeats row ${i + 1}`,
  }))
  const trueRowNo = SYMBOLS.indexOf("TRUE") + 1
  const expected = [
    {
      row_no: trueRowNo,
      rule: "category_sum",
      detail: `categories sum to ${ROWS_PER_SYMBOL}, not 7`,
    },
    ...repeats,
  ]

  test("no read returns more than one batch of symbols' rows", async () => {
    const reads: Array<number> = []
    app = ownershipWorker((rowCount) => reads.push(rowCount))
    await post("tipe", ASOF, interleavedCsv())

    expect(Math.max(...reads)).toBeLessThanOrEqual(
      SYMBOLS_PER_READ * ROWS_PER_SYMBOL
    )
  })

  test("a repeat names the earliest row across the whole file, and the flagged rows count", async () => {
    const fileId = await post("tipe", ASOF, interleavedCsv())

    expect(await flagsOf(fileId)).toEqual(expected)
    const status = (await (await app.status()).json()) as {
      flaggedRows: number
    }
    expect(status.flaggedRows).toBe(expected.length)
    expect(await fileStatus(fileId)).toBe("loaded")
  })

  test("a retried step changes no flag", async () => {
    const response = await app.postCsv(interleavedCsv(), {
      asOf: ASOF,
      dataset: "tipe",
    })
    const { fileId } = (await response.json()) as { fileId: string }
    await app.load.runAll({ repeatEachStep: true })

    expect(await flagsOf(fileId)).toEqual(expected)
  })
})

describe("the status endpoint", () => {
  const flaggedRows = async () =>
    ((await (await app.status()).json()) as { flaggedRows: number }).flaggedRows

  const flag = (fileId: string, rowNo: number, rule: RowFlag["rule"]) =>
    upsertFlags(app.db, fileId, [{ rowNo, rule, detail: "seeded" }])

  test("counts the flagged rows of loaded files", async () => {
    await post(
      "satu-persen",
      "2026-02-27",
      fixture("satu-persen-2026-02-27.csv")
    )
    await post(
      "satu-persen",
      "2026-03-31",
      fixture("satu-persen-2026-03-31.csv")
    )
    expect(await flaggedRows()).toBe(2)
  })

  test("a row flagged twice is one flagged row", async () => {
    const fileId = await post(
      "satu-persen",
      "2026-02-27",
      fixture("satu-persen-2026-02-27.csv")
    )
    const [only] = await flagsOf(fileId)
    await flag(fileId, only?.row_no ?? 0, "duplicate_key")
    expect(await flaggedRows()).toBe(1)
  })

  test("a later version of the same as-of replaces the earlier one's count", async () => {
    const asOf = "2026-02-27"
    const csv = fixture(`satu-persen-${asOf}.csv`)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime("2026-10-31T07:00:00Z")
      await post("satu-persen", asOf, csv)
      vi.setSystemTime("2026-10-31T08:00:00Z")
      const response = await app.postCsv(csv, {
        asOf,
        dataset: "satu-persen",
        sourceSha256: sha256("a revised xlsx"),
      })
      expect(response.status).toBe(202)
      await app.load.runAll()
    } finally {
      vi.useRealTimers()
    }
    expect(await flaggedRows()).toBe(1)
  })

  test("of two versions received in the same millisecond, only the later counts", async () => {
    const asOf = "2026-02-27"
    const csv = fixture(`satu-persen-${asOf}.csv`)
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-31T07:00:00Z"),
    })
    try {
      await post("satu-persen", asOf, csv)
      const response = await app.postCsv(csv, {
        asOf,
        dataset: "satu-persen",
        sourceSha256: sha256("a revised xlsx"),
      })
      expect(response.status).toBe(202)
      await app.load.runAll()
    } finally {
      vi.useRealTimers()
    }
    expect(await flaggedRows()).toBe(1)
  })

  test("a file not yet loaded does not count", async () => {
    const asOf = "2026-02-27"
    const response = await app.postCsv(fixture(`satu-persen-${asOf}.csv`), {
      asOf,
      dataset: "satu-persen",
    })
    const { fileId } = (await response.json()) as { fileId: string }
    await flag(fileId, 1, "row_sum")
    expect(await flaggedRows()).toBe(0)
  })
})

describe("a Holder position", () => {
  test("names differing only in punctuation or case are one holder", () => {
    expect(holderKey("PT. Trimegah-Sekuritas, tbk")).toBe(
      holderKey("PT TRIMEGAH SEKURITAS TBK")
    )
  })

  test("PT X and X, PT stay separate", () => {
    expect(holderKey("PT X")).not.toBe(holderKey("X, PT"))
  })

  test("AADI's GARIBALDI THOHIR lines on 2026-05-29 sum to the published total", async () => {
    const asOf = "2026-05-29"
    const fileId = await post(
      "lima-persen",
      asOf,
      fixture(`lima-persen-${asOf}.csv`)
    )
    const position = await app.db
      .prepare(
        "SELECT SUM(shares) AS shares, COUNT(*) AS lines FROM holding_lines_5 WHERE file_id = ? AND symbol = 'AADI' AND holder_key = ?"
      )
      .bind(fileId, holderKey("Garibaldi Thohir"))
      .first()
    expect(position).toEqual({ shares: 454_011_607, lines: 4 })
  })
})
