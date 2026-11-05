import { beforeEach, describe, expect, test } from "vitest"

import { fixture, ownershipWorker } from "../support/ownership"

let app: ReturnType<typeof ownershipWorker>

beforeEach(() => {
  app = ownershipWorker()
})

const loaded = async (dataset: string, asOf: string) => {
  const response = await app.postCsv(fixture(`${dataset}-${asOf}.csv`), {
    asOf,
    dataset,
  })
  expect(response.status).toBe(202)
  const { fileId } = (await response.json()) as { fileId: string }
  await app.load.runAll()
  return fileId
}

const stored = async (table: string, fileId: string) =>
  (
    await app.db
      .prepare(`SELECT * FROM ${table} WHERE file_id = ? ORDER BY row_no`)
      .bind(fileId)
      .all()
  ).results

describe("the 1% dataset", () => {
  test("a file through 2026-03-31 keeps its type code, with classification empty", async () => {
    const lines = await stored(
      "holding_lines_1",
      await loaded("satu-persen", "2026-03-31")
    )
    expect(lines).toHaveLength(17)
    expect(lines[0]).toMatchObject({
      row_no: 1,
      symbol: "SMRA",
      investor_name: "PT SEMAROP AGUNG",
      holder_key: "PTSEMAROPAGUNG",
      classification: null,
      investor_type_code: "CP",
      local_foreign: "L",
      nationality: null,
      scripless: 3_814_000_015,
      scrip: 2_123_804_901,
      total: 5_909_304_916,
      percent: 35.8,
    })
    expect(lines.every((l) => l.classification === null)).toBe(true)
  })

  test("a newer file has classification and no type code, and no mapping fills either", async () => {
    const lines = await stored(
      "holding_lines_1",
      await loaded("satu-persen", "2026-04-30")
    )
    expect(lines).toHaveLength(18)
    expect(lines[0]).toMatchObject({
      symbol: "MAYA",
      investor_name: "JONATHAN TAHIR",
      classification: "Individual",
      investor_type_code: null,
    })
    expect(lines.every((l) => l.investor_type_code === null)).toBe(true)
    // Six published rows have no classification, and stay that way.
    expect(lines.filter((l) => l.classification === null)).toHaveLength(6)
  })

  test("an older line's empty cells are not zero", async () => {
    const lines = await stored(
      "holding_lines_1",
      await loaded("satu-persen", "2026-02-27")
    )
    expect(lines).toHaveLength(17)
    expect(lines[0]).toMatchObject({
      symbol: "MAYA",
      local_foreign: null,
      investor_type_code: null,
      scripless: 0,
      total: 6_023_326_332,
    })
  })

  test("the type code is accepted only as the trailing column", async () => {
    const response = await app.postCsv(
      "as_of,symbol,issuer_name,investor_name,investor_type_code,classification,local_foreign,nationality,domicile,scripless,scrip,total,percent\n",
      { asOf: "2026-03-31", dataset: "satu-persen", rowCount: 0 }
    )
    expect(response.status).toBe(400)
  })
})

describe("the investor type dataset", () => {
  test("an older file loads with side empty", async () => {
    const rows = await stored(
      "breakdown_by_type",
      await loaded("tipe", "2025-11-28")
    )
    expect(rows).toHaveLength(36)
    expect(rows[0]).toMatchObject({
      row_no: 1,
      symbol: "BBCA",
      number_of_shares: 123_275_050_000,
      side: null,
      category: "CP",
      band: "below_5",
      shares: 2_095_446_304,
      total_scripless: 52_453_691_120,
    })
    expect(rows.every((r) => r.side === null)).toBe(true)
  })

  test("a newer file keeps its side, and a share count of zero stays zero", async () => {
    const rows = await stored(
      "breakdown_by_type",
      await loaded("tipe", "2026-09-30")
    )
    expect(rows).toHaveLength(72)
    expect(rows[0]).toMatchObject({ symbol: "EDJSA", side: "local" })
    expect(rows.at(-1)).toMatchObject({
      symbol: "TRUE",
      side: "foreign",
      category: "SC",
      band: "at_or_above_5",
      shares: 0,
    })
  })

  test("refuses another dataset's columns", async () => {
    const response = await app.postCsv(fixture("klasifikasi-2026-08-31.csv"), {
      asOf: "2026-08-31",
      dataset: "tipe",
    })
    expect(response.status).toBe(400)
  })
})

describe("the investor classification dataset", () => {
  test("an older file loads with side empty", async () => {
    const rows = await stored(
      "breakdown_by_classification",
      await loaded("klasifikasi", "2026-08-31")
    )
    expect(rows).toHaveLength(78)
    expect(rows[0]).toMatchObject({
      symbol: "BBCA",
      issuer_name: "BANK CENTRAL ASIA Tbk",
      side: null,
      category: "BANK",
      shares: 1_728_998_752,
      total_scripless: 52_453_691_120,
    })
    expect(rows.every((r) => r.side === null)).toBe(true)
  })

  test("a newer file keeps its side", async () => {
    const rows = await stored(
      "breakdown_by_classification",
      await loaded("klasifikasi", "2026-09-30")
    )
    expect(rows).toHaveLength(156)
    expect(rows[0]).toMatchObject({
      symbol: "BBCA",
      side: "local",
      category: "Bank",
      shares: 433_318_700,
    })
  })
})

describe("every format", () => {
  test.each([
    ["satu-persen", "2026-02-27", "holding_lines_1", 6],
    ["satu-persen", "2026-04-30", "holding_lines_1", 6],
    ["tipe", "2025-11-28", "breakdown_by_type", 18],
    ["tipe", "2026-09-30", "breakdown_by_type", 36],
    ["klasifikasi", "2026-08-31", "breakdown_by_classification", 39],
    ["klasifikasi", "2026-09-30", "breakdown_by_classification", 78],
  ])(
    "%s %s keeps TRUE as a symbol, not a boolean",
    async (dataset, asOf, table, rows) => {
      const lines = await stored(table, await loaded(dataset, asOf))
      expect(lines.filter((l) => l.symbol === "TRUE")).toHaveLength(rows)
    }
  )

  test("reports on the status endpoint, each on its own feed", async () => {
    await loaded("satu-persen", "2026-03-31")
    await loaded("tipe", "2025-11-28")
    await loaded("klasifikasi", "2026-08-31")

    const { feeds, loading } = (await (await app.status()).json()) as {
      feeds: Record<string, { asOf: string | null }>
      loading: Array<unknown>
    }
    expect(loading).toEqual([])
    expect(feeds["satu-persen"]?.asOf).toBe("2026-03-31")
    expect(feeds.tipe?.asOf).toBe("2025-11-28")
    expect(feeds.klasifikasi?.asOf).toBe("2026-08-31")
    expect(feeds["lima-persen"]?.asOf).toBeNull()
  })
})

describe("the 5% re-conversion", () => {
  test("MAMIP keeps the share counts the older conversion emptied", async () => {
    const lines = await stored(
      "holding_lines_5",
      await loaded("lima-persen", "2026-10-29")
    )
    expect(lines).toHaveLength(8)
    const mamip = lines.filter((l) => l.symbol === "MAMIP")
    expect(mamip).toHaveLength(5)
    expect(mamip.every((l) => typeof l.shares === "number")).toBe(true)
    expect(mamip.at(-1)).toMatchObject({
      holder_name: "WELLY ANDRY",
      shares: 447_500,
      combined_shares: 447_500,
      percent: 7.46,
    })
  })
})

describe("a column the store requires", () => {
  const LINES = {
    "lima-persen": [
      "as_of,previous_date,holder_no,symbol,issuer_name,account_holder,holder_name,account_name,nationality,domicile,status,previous_shares,previous_combined_shares,previous_percent,shares,combined_shares,percent,change",
      "2026-10-29,2026-10-28,1,BBCA,Issuer,Custodian,Holder,Account,,,L,1,1,1.5,1,1,1.5,0",
    ],
    "satu-persen": [
      "as_of,symbol,issuer_name,investor_name,classification,local_foreign,nationality,domicile,scripless,scrip,total,percent",
      "2026-10-29,BBCA,Issuer,Holder,Bank,L,,,1,0,1,1.5",
    ],
    tipe: [
      "as_of,symbol,number_of_shares,side,category,band,shares,total_scripless",
      "2026-10-29,BBCA,1,local,CP,below_5,1,1",
    ],
    klasifikasi: [
      "as_of,symbol,issuer_name,side,category,shares,total_scripless",
      "2026-10-29,BBCA,Issuer,local,Bank,1,1",
    ],
  } as const

  const withEmpty = (dataset: keyof typeof LINES, column: string) => {
    const [header, line] = LINES[dataset]
    const at = header.split(",").indexOf(column)
    expect(at).toBeGreaterThanOrEqual(0)
    const cells = line.split(",").map((cell, i) => (i === at ? "" : cell))
    return `${header}\n${cells.join(",")}\n`
  }

  test.each([
    ["lima-persen", "symbol"],
    ["satu-persen", "symbol"],
    ["tipe", "symbol"],
    ["tipe", "category"],
    ["tipe", "band"],
    ["klasifikasi", "symbol"],
    ["klasifikasi", "category"],
  ] as const)(
    "%s with %s empty returns 400 and stores nothing",
    async (dataset, column) => {
      const response = await app.postCsv(withEmpty(dataset, column), {
        asOf: "2026-10-29",
        dataset,
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain(column)
      expect(app.files.keys()).toEqual([])
      const { loading, failed } = (await (await app.status()).json()) as {
        loading: Array<unknown>
        failed: Array<unknown>
      }
      expect(loading).toEqual([])
      expect(failed).toEqual([])
    }
  )

  test.each(["lima-persen", "satu-persen", "tipe", "klasifikasi"] as const)(
    "%s loads when only optional cells are empty",
    async (dataset) => {
      const [header, line] = LINES[dataset]
      const response = await app.postCsv(`${header}\n${line}\n`, {
        asOf: "2026-10-29",
        dataset,
      })
      expect(response.status).toBe(202)
      await app.load.runAll()
      const { failed } = (await (await app.status()).json()) as {
        failed: Array<unknown>
      }
      expect(failed).toEqual([])
    }
  )
})

describe("the 1% type code belongs to an as-of", () => {
  const OLDER = fixture("satu-persen-2026-03-31.csv")
  const NEWER = fixture("satu-persen-2026-04-30.csv")

  test("a later as-of carrying it returns 400 and stores nothing", async () => {
    const csv = OLDER.replaceAll("2026-03-31", "2026-04-30")
    const response = await app.postCsv(csv, {
      asOf: "2026-04-30",
      dataset: "satu-persen",
    })
    expect(response.status).toBe(400)
    expect(app.files.keys()).toEqual([])
  })

  test("an as-of through 2026-03-31 lacking it returns 400 and stores nothing", async () => {
    const csv = NEWER.replaceAll("2026-04-30", "2026-03-31")
    const response = await app.postCsv(csv, {
      asOf: "2026-03-31",
      dataset: "satu-persen",
    })
    expect(response.status).toBe(400)
    expect(app.files.keys()).toEqual([])
  })

  test("a file with no rows is held to the same rule", async () => {
    const [header = ""] = NEWER.split("\n")
    const response = await app.postCsv(`${header}\n`, {
      asOf: "2026-03-31",
      dataset: "satu-persen",
      rowCount: 0,
    })
    expect(response.status).toBe(400)
  })

  test.each([
    ["2026-03-31", OLDER],
    ["2026-04-30", NEWER],
  ])("the boundary as-of %s is accepted as published", async (asOf, csv) => {
    const response = await app.postCsv(csv, { asOf, dataset: "satu-persen" })
    expect(response.status).toBe(202)
  })
})

describe("a field's quoting", () => {
  const AADI = fixture("lima-persen-2026-05-29.csv")

  test.each([
    ["an integer with quotes inside", ",84301663,", ',84"301"663,'],
    [
      "text after a closing quote",
      '"ADARO ANDALAN INDONESIA Tbk, PT"',
      '"ab"cd',
    ],
    ["an unquoted text cell with a quote inside", ",AADI,", ',AA"DI,'],
  ])("%s returns 400 and stores nothing", async (_, cell, malformed) => {
    const response = await app.postCsv(AADI.replace(cell, malformed), {
      asOf: "2026-05-29",
    })
    expect(response.status).toBe(400)
    expect(app.files.keys()).toEqual([])
  })

  test.each([
    ["a figure", ",84301663,", ",8430\r1663,"],
    ["a text cell", ",AADI,", ",AA\rDI,"],
  ])(
    "a carriage return inside %s returns 400 and stores nothing",
    async (_, cell, stray) => {
      const response = await app.postCsv(AADI.replace(cell, stray), {
        asOf: "2026-05-29",
      })
      expect(response.status).toBe(400)
      expect(app.files.keys()).toEqual([])
    }
  )

  test("a bare carriage return before the end of the file returns 400 and stores nothing", async () => {
    const response = await app.postCsv(`${AADI.trimEnd()}\r`, {
      asOf: "2026-05-29",
    })
    expect(response.status).toBe(400)
    expect(app.files.keys()).toEqual([])
  })

  test("CRLF record delimiters are accepted", async () => {
    const response = await app.postCsv(AADI.replaceAll("\n", "\r\n"), {
      asOf: "2026-05-29",
    })
    expect(response.status).toBe(202)
  })

  test("a whole header inside one pair of quotes returns 400 and stores nothing", async () => {
    const [header = "", ...data] = AADI.split("\n")
    const response = await app.postCsv([`"${header}"`, ...data].join("\n"), {
      asOf: "2026-05-29",
    })
    expect(response.status).toBe(400)
    expect(app.files.keys()).toEqual([])
  })
})
