import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { IMPORTS_PATH } from "@/ownership/routes"
import worker from "@/server"

import {
  fixture,
  OWNERSHIP_SECRET,
  ownershipWorker,
  RELAY_SECRET,
  sha256,
} from "../support/ownership"
import { FELL_THROUGH } from "../support/start-entry"

const AADI = fixture("lima-persen-2026-05-29.csv")
const REPEATS = fixture("lima-persen-2026-10-28.csv")
const NO_FILE = {
  freshness: "stale",
  asOf: null,
  expectedAsOf: expect.any(String),
  firstReceivedAt: null,
}

let app: ReturnType<typeof ownershipWorker>

beforeEach(() => {
  app = ownershipWorker()
  // Tuesday 19:00 WIB, when the expected as-of is the AADI cut's Friday 05-29.
  vi.setSystemTime(new Date("2026-06-02T12:00:00Z"))
})

afterEach(() => {
  vi.useRealTimers()
})

const storedLines = async (fileId: string) =>
  (
    await app.db
      .prepare(
        "SELECT row_no, symbol, holder_name, holder_key, shares, combined_shares, percent, change FROM holding_lines_5 WHERE file_id = ? ORDER BY row_no"
      )
      .bind(fileId)
      .all()
  ).results

const accepted = async (csv: string, asOf: string) => {
  const response = await app.postCsv(csv, { asOf })
  expect(response.status).toBe(202)
  return (await response.json()) as { fileId: string; status: string }
}

const statusBody = async () => (await app.status()).json() as Promise<any>

describe("posting a 5% file", () => {
  test("returns 202 with a file id, still loading", async () => {
    const body = await accepted(AADI, "2026-05-29")
    expect(body.fileId).toEqual(expect.any(String))
    expect(body.status).toBe("loading")
  })

  test("keeps the CSV by its content hash", async () => {
    await accepted(AADI, "2026-05-29")
    const key = `ownership/lima-persen/${sha256(AADI)}.csv`
    expect(app.files.keys()).toEqual([key])
    expect(await (await app.files.get(key))?.text()).toBe(AADI)
  })

  test("stores each line by file version and row number, as published", async () => {
    const { fileId } = await accepted(AADI, "2026-05-29")
    await app.load.runAll()

    const lines = await storedLines(fileId)
    expect(lines.map((l) => l.row_no)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1)
    )
    // Row 13 of the published AADI cut.
    expect(lines[12]).toEqual({
      row_no: 13,
      symbol: "AADI",
      holder_name: "GARIBALDI THOHIR",
      holder_key: "GARIBALDITHOHIR",
      shares: 202_551_834,
      combined_shares: 454_011_607,
      percent: 5.83,
      change: 0,
    })
    // A continuation line has no combined total: empty, not zero.
    expect(lines[13]?.combined_shares).toBeNull()
    expect(lines[13]?.percent).toBeNull()
  })

  test("keeps exact duplicate lines as separate rows", async () => {
    const { fileId } = await accepted(REPEATS, "2026-10-28")
    await app.load.runAll()

    const dataRows = REPEATS.trimEnd().split("\n").slice(1)
    const distinct = new Set(dataRows)
    expect(distinct.size).toBeLessThan(dataRows.length)
    expect(await storedLines(fileId)).toHaveLength(dataRows.length)
  })

  test("reads a quoted name with a comma as one cell", async () => {
    const { fileId } = await accepted(AADI, "2026-05-29")
    await app.load.runAll()
    const row = await app.db
      .prepare(
        "SELECT issuer_name FROM holding_lines_5 WHERE file_id = ? AND row_no = 1"
      )
      .bind(fileId)
      .first()
    expect(row?.issuer_name).toBe("ADARO ANDALAN INDONESIA Tbk, PT")
  })
})

describe("the load", () => {
  const header = AADI.split("\n")[0]
  const line = AADI.split("\n")[1]
  /** Past one chunk, past the second chunk's boundary. */
  const big = [header, ...Array.from({ length: 2345 }, () => line)].join("\n")

  test("is loading until every row is in, and only then loaded", async () => {
    const { fileId } = await accepted(big, "2026-05-29")
    const inProgress = [{ fileId, dataset: "lima-persen", asOf: "2026-05-29" }]
    const seen: Array<[string, number]> = []

    await app.load.runAll({
      beforeAttempt: async (step) => {
        seen.push([step, (await storedLines(fileId)).length])
        const status = await statusBody()
        expect(status.loading).toEqual(inProgress)
        expect(status.feeds["lima-persen"]).toEqual(NO_FILE)
      },
    })

    expect(seen).toEqual([
      ["read the file", 0],
      ["rows 1 to 1000", 0],
      ["rows 1001 to 2000", 1000],
      ["rows 2001 to 2345", 2000],
      ["read the symbols", 2345],
      ["flag symbols 1 to 1", 2345],
      ["confirm the row count", 2345],
    ])
    const after = await statusBody()
    expect(after.loading).toEqual([])
    expect(after.feeds["lima-persen"].asOf).toBe("2026-05-29")
  })

  test("shows as failed, not loaded, when a chunk step keeps failing", async () => {
    const { fileId } = await accepted(big, "2026-05-29")
    await expect(
      app.load.runAll({
        beforeAttempt: (step) => {
          if (step === "rows 1001 to 2000") throw new Error("D1 went away")
        },
      })
    ).rejects.toThrow("D1 went away")

    const status = await statusBody()
    expect(status.feeds["lima-persen"]).toEqual(NO_FILE)
    expect(status.loading).toEqual([])
    expect(status.failed).toEqual([
      {
        fileId,
        dataset: "lima-persen",
        asOf: "2026-05-29",
        error: "D1 went away",
      },
    ])
  })

  test("a retried step changes nothing", async () => {
    const once = await accepted(big, "2026-05-29")
    await app.load.runAll()
    const expected = await storedLines(once.fileId)

    app = ownershipWorker()
    const { fileId } = await accepted(big, "2026-05-29")
    await app.load.runAll({ repeatEachStep: true })

    expect(await storedLines(fileId)).toEqual(expected)
    const status = await statusBody()
    expect(status.feeds["lima-persen"].asOf).toBe("2026-05-29")
    expect(status.loading).toEqual([])
  })

  test("a step failing once is retried and the file still loads", async () => {
    const { fileId } = await accepted(big, "2026-05-29")
    await app.load.runAll({
      beforeAttempt: (step, attempt) => {
        if (step === "rows 2001 to 2345" && attempt === 1)
          throw new Error("transient")
      },
    })
    expect(await storedLines(fileId)).toHaveLength(2345)
    expect((await statusBody()).feeds["lima-persen"].asOf).toBe("2026-05-29")
  })
})

describe("the status endpoint", () => {
  test("shows all four feeds, with no as-of for a feed with no file", async () => {
    const response = await app.status()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      feeds: {
        "lima-persen": NO_FILE,
        "satu-persen": NO_FILE,
        tipe: NO_FILE,
        klasifikasi: NO_FILE,
      },
      calendarListed: true,
      lastRun: null,
      loading: [],
      failed: [],
      flaggedRows: 0,
    })
  })

  test("shows a loaded file's as-of and when it first arrived, on its feed alone", async () => {
    await accepted(AADI, "2026-05-29")
    await app.load.runAll()

    const { feeds } = await statusBody()
    expect(feeds["lima-persen"]).toEqual({
      freshness: "end-of-day",
      asOf: "2026-05-29",
      expectedAsOf: "2026-05-29",
      firstReceivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
    expect(feeds["satu-persen"]).toEqual(NO_FILE)
    expect(feeds.tipe).toEqual(NO_FILE)
    expect(feeds.klasifikasi).toEqual(NO_FILE)
  })

  test("shows the latest as-of of two loaded files, whichever arrived last", async () => {
    await accepted(REPEATS, "2026-10-28")
    await accepted(AADI, "2026-05-29")
    await app.load.runAll()
    expect((await statusBody()).feeds["lima-persen"].asOf).toBe("2026-10-28")
  })
})

describe("the secret", () => {
  test.each([
    ["the relay's", RELAY_SECRET],
    ["a wrong one", "nope"],
  ])("%s is refused with 403 and stores nothing", async (_, secret) => {
    const posted = await app.postCsv(AADI, { asOf: "2026-05-29", secret })
    expect(posted.status).toBe(403)
    expect(app.files.keys()).toEqual([])
    expect((await app.status(secret)).status).toBe(403)
  })

  test("the right secret still passes", async () => {
    expect((await app.status(OWNERSHIP_SECRET)).status).toBe(200)
  })

  test("another method falls through to Start", async () => {
    const response = await worker.fetch(
      new Request(`https://dash.example${IMPORTS_PATH}`),
      app.env
    )
    expect(await response.text()).toBe(FELL_THROUGH)
  })
})
