import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  OWNERSHIP_SECRET,
  ownershipWorker,
  RELAY_SECRET,
} from "../support/ownership"

let app: ReturnType<typeof ownershipWorker>

beforeEach(() => {
  app = ownershipWorker()
})

afterEach(() => {
  vi.useRealTimers()
})

const at = (wib: string) => vi.setSystemTime(new Date(`${wib}+07:00`))

/** A loaded file seeded directly, so a test fixes any as-of without a CSV of it. */
const loaded = (dataset: string, asOf: string) =>
  app.db
    .prepare(
      `INSERT INTO ownership_files
        (id, dataset, as_of, source_filename, source_sha256, csv_sha256, row_count, first_received_at, status)
       VALUES (?, ?, ?, 'f.xlsx', ?, ?, 0, '2026-01-01T00:00:00Z', 'loaded')`
    )
    .bind(`${dataset}-${asOf}`, dataset, asOf, asOf, dataset)
    .run()

const statusBody = async () => (await app.status()).json() as Promise<any>

describe("the 5% feed", () => {
  test.each([
    ["Monday 19:00 expects Friday", "2026-11-02T19:00:00", "2026-10-30"],
    ["Tuesday 10:00 still expects Friday", "2026-11-03T10:00:00", "2026-10-30"],
    ["Tuesday 19:00 moves on to Monday", "2026-11-03T19:00:00", "2026-11-02"],
    ["Monday 18:29 has not moved on", "2026-11-02T18:29:00", "2026-10-29"],
    ["Monday 18:30 has moved on", "2026-11-02T18:30:00", "2026-10-30"],
    ["Saturday expects Thursday", "2026-10-31T12:00:00", "2026-10-29"],
    ["Sunday expects Thursday", "2026-11-01T12:00:00", "2026-10-29"],
    ["the holiday itself looks back", "2026-08-17T19:00:00", "2026-08-13"],
    ["the day after 08-17 skips it", "2026-08-18T19:00:00", "2026-08-14"],
    ["before 18:30 after 08-17", "2026-08-18T10:00:00", "2026-08-13"],
  ])("%s", async (_, now, expected) => {
    at(now)
    await loaded("lima-persen", expected)
    const feed = (await statusBody()).feeds["lima-persen"]
    expect(feed.expectedAsOf).toBe(expected)
    expect(feed.freshness).toBe("end-of-day")
  })

  test("is stale with an as-of older than expected", async () => {
    at("2026-11-02T19:00:00")
    await loaded("lima-persen", "2026-10-29")
    const feed = (await statusBody()).feeds["lima-persen"]
    expect(feed.asOf).toBe("2026-10-29")
    expect(feed.freshness).toBe("stale")
  })

  test("is stale with no file, and still says what it expects", async () => {
    at("2026-11-02T19:00:00")
    expect((await statusBody()).feeds["lima-persen"]).toEqual({
      freshness: "stale",
      asOf: null,
      expectedAsOf: "2026-10-30",
      firstReceivedAt: null,
    })
  })

  test("a file that has not finished loading does not count", async () => {
    at("2026-11-02T19:00:00")
    await loaded("lima-persen", "2026-10-29")
    await app.db
      .prepare(
        `INSERT INTO ownership_files
          (id, dataset, as_of, source_filename, source_sha256, csv_sha256, row_count, first_received_at, status)
         VALUES ('new', 'lima-persen', '2026-10-30', 'f.xlsx', 's', 'c', 0, '2026-11-02T00:00:00Z', 'loading')`
      )
      .run()
    expect((await statusBody()).feeds["lima-persen"].freshness).toBe("stale")
  })
})

describe.each(["satu-persen", "tipe", "klasifikasi"])(
  "the monthly feed %s",
  (dataset) => {
    test("through the 10th, August's file is enough in October", async () => {
      at("2026-10-10T23:59:00")
      await loaded(dataset, "2026-08-31")
      const feed = (await statusBody()).feeds[dataset]
      expect(feed.expectedAsOf).toBe("2026-08")
      expect(feed.freshness).toBe("end-of-day")
    })

    test("after the 10th, last month's file is missing", async () => {
      at("2026-10-11T00:00:00")
      await loaded(dataset, "2026-08-31")
      const feed = (await statusBody()).feeds[dataset]
      expect(feed.expectedAsOf).toBe("2026-09")
      expect(feed.freshness).toBe("stale")
    })

    test("after the 10th, last month's file counts by its month", async () => {
      at("2026-10-11T00:00:00")
      await loaded(dataset, "2026-09-29")
      expect((await statusBody()).feeds[dataset].freshness).toBe("end-of-day")
    })

    test("on 2026-10-05 a latest file of 2026-07-31 is stale", async () => {
      at("2026-10-05T12:00:00")
      await loaded(dataset, "2026-07-31")
      const feed = (await statusBody()).feeds[dataset]
      expect(feed.expectedAsOf).toBe("2026-08")
      expect(feed.freshness).toBe("stale")
    })

    test("crosses the year", async () => {
      at("2027-01-05T12:00:00")
      expect((await statusBody()).feeds[dataset].expectedAsOf).toBe("2026-11")
      at("2027-01-11T12:00:00")
      expect((await statusBody()).feeds[dataset].expectedAsOf).toBe("2026-12")
    })
  }
)

test("the 10th is the 10th in WIB, not UTC", async () => {
  // 2026-10-10T18:00Z is already the 11th at 01:00 WIB.
  vi.setSystemTime(new Date("2026-10-10T18:00:00Z"))
  expect((await statusBody()).feeds.tipe.expectedAsOf).toBe("2026-09")
})

describe("a year with no holiday list", () => {
  test("falls back to weekdays and says so", async () => {
    // Thursday 2028-08-17 would be a holiday; the list stops at 2027.
    at("2028-08-18T19:00:00")
    const body = await statusBody()
    expect(body.calendarListed).toBe(false)
    expect(body.feeds["lima-persen"].expectedAsOf).toBe("2028-08-17")
  })

  test("a listed year says it is listed", async () => {
    at("2027-08-18T19:00:00")
    const body = await statusBody()
    expect(body.calendarListed).toBe(true)
    // Wednesday, after Tuesday 2027-08-17: the list skips it.
    expect(body.feeds["lima-persen"].expectedAsOf).toBe("2027-08-16")
  })
})

describe("run reports", () => {
  const REPORT = {
    ranAt: "2026-11-02T03:00:00Z",
    outcome: "nothing-new",
    detail: null,
    filesSent: 0,
  }

  test("a report returns 204 and shows on status as the last run", async () => {
    expect((await app.postRun(REPORT)).status).toBe(204)
    expect((await statusBody()).lastRun).toEqual({
      ranAt: "2026-11-02T03:00:00.000Z",
      outcome: "nothing-new",
      detail: null,
    })
  })

  test("no report means no last run", async () => {
    expect((await statusBody()).lastRun).toBeNull()
  })

  test("the last run is the latest instant, whatever its offset or arrival", async () => {
    // 09:00 WIB is 02:00Z, earlier than the 03:00Z report, yet sorts later as text.
    await app.postRun({ ...REPORT, outcome: "new-files", filesSent: 1 })
    await app.postRun({
      ...REPORT,
      ranAt: "2026-11-02T09:00:00+07:00",
      outcome: "blocked",
      detail: "403",
    })
    expect((await statusBody()).lastRun.outcome).toBe("new-files")
  })

  test("a repeated report is accepted and keeps the first", async () => {
    await app.postRun({ ...REPORT, outcome: "failed", detail: "first" })
    expect((await app.postRun(REPORT)).status).toBe(204)
    expect((await statusBody()).lastRun.detail).toBe("first")
  })

  test.each([
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["a null body", "null"],
    ["no ranAt", { ...REPORT, ranAt: undefined }],
    ["ranAt not a date", { ...REPORT, ranAt: "yesterday" }],
    ["ranAt with no time", { ...REPORT, ranAt: "2026-11-02" }],
    ["ranAt with no offset", { ...REPORT, ranAt: "2026-11-02T03:00:00" }],
    ["ranAt out of range", { ...REPORT, ranAt: "2026-13-02T03:00:00Z" }],
    ["an unknown outcome", { ...REPORT, outcome: "ok" }],
    ["detail missing", { ...REPORT, detail: undefined }],
    ["detail a number", { ...REPORT, detail: 1 }],
    ["filesSent a string", { ...REPORT, filesSent: "0" }],
    ["filesSent missing", { ...REPORT, filesSent: undefined }],
    ["filesSent negative", { ...REPORT, filesSent: -1 }],
    ["filesSent fractional", { ...REPORT, filesSent: 1.5 }],
  ])("%s returns 400 and stores nothing", async (_, body) => {
    expect((await app.postRun(body)).status).toBe(400)
    expect((await statusBody()).lastRun).toBeNull()
  })

  test("a wrong secret returns 403 and stores nothing", async () => {
    expect((await app.postRun(REPORT, RELAY_SECRET)).status).toBe(403)
    expect((await app.status(OWNERSHIP_SECRET)).status).toBe(200)
    expect((await statusBody()).lastRun).toBeNull()
  })
})
