import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import worker from "@/server"

import {
  fixture,
  OWNERSHIP_SECRET,
  ownershipWorker,
  sha256,
} from "../support/ownership"

const AADI = fixture("lima-persen-2026-05-29.csv")
const AS_OF = "2026-05-29"
/** The same file with one cell changed, as a converter fix would. */
const RECONVERTED = AADI.replace("84301663", "84301664")
const SOURCE = sha256("the xlsx")
const REVISED_SOURCE = sha256("the revised xlsx")

const T1 = "2026-05-30T01:00:00.000Z"
const T2 = "2026-05-30T02:00:00.000Z"
const T3 = "2026-05-30T03:00:00.000Z"

let app: ReturnType<typeof ownershipWorker>

beforeEach(() => {
  app = ownershipWorker()
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(T1) })
})

afterEach(() => {
  vi.useRealTimers()
})

const post = (csv: string, source = SOURCE, headers = {}) =>
  app.postCsv(csv, { asOf: AS_OF, sourceSha256: source, headers })

const fileIdOf = async (response: Response) => {
  expect(response.status).toBe(202)
  return ((await response.json()) as { fileId: string }).fileId
}

const statusBody = async () => (await app.status()).json() as Promise<any>

const versionCount = async () =>
  (
    await app.db
      .prepare("SELECT COUNT(*) AS n FROM ownership_files")
      .first<{ n: number }>()
  )?.n

const rowsOf = async (fileId: string) =>
  (
    await app.db
      .prepare("SELECT COUNT(*) AS n FROM holding_lines_5 WHERE file_id = ?")
      .bind(fileId)
      .first<{ n: number }>()
  )?.n

const failConfirm = (step: string) => {
  if (step === "confirm the row count") throw new Error("D1 went away")
}

/** Posts a file whose load exhausts its retries. */
const postFailing = async () => {
  const fileId = await fileIdOf(await post(AADI))
  await expect(app.load.runAll({ beforeAttempt: failConfirm })).rejects.toThrow(
    "D1 went away"
  )
  return fileId
}

describe("a re-send", () => {
  test("of a loading file returns 200 with the file and adds nothing", async () => {
    const fileId = await fileIdOf(await post(AADI))

    const again = await post(AADI)

    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ fileId, status: "loading" })
    expect(await versionCount()).toBe(1)
    expect(app.load.ids()).toEqual([`${fileId}-1`])
  })

  test("of a loaded file returns 200 with the file and adds nothing", async () => {
    const fileId = await fileIdOf(await post(AADI))
    await app.load.runAll()

    const again = await post(AADI)

    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ fileId, status: "loaded" })
    expect(await versionCount()).toBe(1)
    expect(app.load.ids()).toEqual([`${fileId}-1`])
  })

  test("of a failed file keeps its CSV again, so a lost one still recovers", async () => {
    const fileId = await fileIdOf(await post(AADI))
    await app.files.delete(`ownership/lima-persen/${sha256(AADI)}.csv`)
    await expect(app.load.runAll()).rejects.toThrow("no CSV kept")

    const again = await post(AADI)
    await app.load.runAll()

    expect(again.status).toBe(202)
    expect(await again.json()).toEqual({ fileId, status: "loading" })
    expect(await (await post(AADI)).json()).toEqual({
      fileId,
      status: "loaded",
    })
  })
})

describe("a re-send of a loading file with no instance", () => {
  const postOrphan = async () => {
    const fileId = await fileIdOf(await post(AADI))
    app.load.forgetInstances()
    return fileId
  }

  test("creates the instance under the same id, answers 200, and the file loads", async () => {
    const fileId = await postOrphan()

    const response = await post(AADI)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ fileId, status: "loading" })
    expect(app.load.ids()).toEqual([`${fileId}-1`])
    await app.load.runAll()
    expect(await rowsOf(fileId)).toBe(16)
    expect((await post(AADI)).status).toBe(200)
    expect((await statusBody()).loading).toEqual([])
  })

  test("answers 503 and stays loading when Workflows refuses, and the next re-send recovers", async () => {
    const fileId = await postOrphan()

    app.load.refuseNextCreate()
    expect((await post(AADI)).status).toBe(503)
    expect((await statusBody()).failed).toEqual([])
    expect((await statusBody()).loading).toHaveLength(1)

    expect((await post(AADI)).status).toBe(200)
    expect(app.load.ids()).toEqual([`${fileId}-1`])
  })

  test("leaves a live instance alone", async () => {
    const fileId = await fileIdOf(await post(AADI))

    expect((await post(AADI)).status).toBe(200)
    expect((await post(AADI)).status).toBe(200)

    expect(app.load.ids()).toEqual([`${fileId}-1`])
  })
})

describe("a re-send of a loading file whose instance has stopped", () => {
  const expectRestarted = async (fileId: string, response: Response) => {
    expect(await response.json()).toEqual({ fileId, status: "loading" })
    expect(app.load.ids()).toEqual([`${fileId}-1`, `${fileId}-2`])
    await app.load.runAll()
    const status = await statusBody()
    expect(status.loading).toEqual([])
    expect(status.failed).toEqual([])
    expect(status.feeds["lima-persen"].asOf).toBe(AS_OF)
  }

  test("after erroring without marking the file failed, starts the next attempt", async () => {
    const fileId = await fileIdOf(await post(AADI))
    await expect(
      app.load.runAll({
        beforeAttempt: (step) => {
          failConfirm(step)
          if (step === "mark the file failed") throw new Error("D1 is down")
        },
      })
    ).rejects.toThrow("D1 is down")
    expect((await statusBody()).loading).toHaveLength(1)

    const response = await post(AADI)

    expect(response.status).toBe(202)
    await expectRestarted(fileId, response)
  })

  test("after being terminated, starts the next attempt", async () => {
    const fileId = await fileIdOf(await post(AADI))
    app.load.terminate(`${fileId}-1`)

    const response = await post(AADI)

    expect(response.status).toBe(202)
    await expectRestarted(fileId, response)
  })

  test("leaves the newer attempt loading when the stopped one confirms late", async () => {
    const fileId = await fileIdOf(await post(AADI))
    let resent: Response | undefined

    await app.load.runAll({
      beforeAttempt: async (step) => {
        if (step !== "confirm the row count") return
        app.load.terminate(`${fileId}-1`)
        resent = await post(AADI)
      },
    })

    expect(resent?.status).toBe(202)
    const status = await statusBody()
    expect(status.loading).toHaveLength(1)
    expect(status.feeds["lima-persen"].asOf).toBeNull()
    await app.load.runAll()
    expect((await statusBody()).feeds["lima-persen"].asOf).toBe(AS_OF)
  })

  test("while it runs, answers 200 and starts nothing", async () => {
    const fileId = await fileIdOf(await post(AADI))
    let resent: Response | undefined

    await app.load.runAll({
      beforeAttempt: async (step) => {
        if (step === "confirm the row count") resent = await post(AADI)
      },
    })

    expect(resent?.status).toBe(200)
    expect(app.load.ids()).toEqual([`${fileId}-1`])
  })
})

describe("a failed load", () => {
  test("shows on the status endpoint with its error, none of its rows in force", async () => {
    const fileId = await postFailing()

    const status = await statusBody()
    expect(status.failed).toEqual([
      {
        fileId,
        dataset: "lima-persen",
        asOf: AS_OF,
        error: "D1 went away",
      },
    ])
    expect(status.loading).toEqual([])
    expect(status.feeds["lima-persen"].asOf).toBeNull()
  })

  test("is recovered by a re-send, in a new instance", async () => {
    const fileId = await postFailing()

    const again = await post(AADI)

    expect(again.status).toBe(202)
    expect(await again.json()).toEqual({ fileId, status: "loading" })
    expect(await versionCount()).toBe(1)
    expect((await statusBody()).failed).toEqual([])

    await app.load.runAll()
    const status = await statusBody()
    expect(status.failed).toEqual([])
    expect(status.feeds["lima-persen"].asOf).toBe(AS_OF)
    expect(await rowsOf(fileId)).toBe(16)
  })

  test("can fail and be recovered more than once, each in its own instance", async () => {
    const fileId = await postFailing()
    await post(AADI)
    await expect(
      app.load.runAll({ beforeAttempt: failConfirm })
    ).rejects.toThrow("D1 went away")

    expect((await post(AADI)).status).toBe(202)
    await app.load.runAll()

    expect(app.load.ids()).toEqual([
      `${fileId}-1`,
      `${fileId}-2`,
      `${fileId}-3`,
    ])
    expect((await statusBody()).feeds["lima-persen"].asOf).toBe(AS_OF)
  })

  test("that could not start shows as failed, and a re-send recovers it", async () => {
    app.load.refuseNextCreate()

    const refused = await post(AADI)

    expect(refused.status).toBe(503)
    expect((await statusBody()).failed).toEqual([
      expect.objectContaining({ error: "Workflows is unavailable" }),
    ])

    expect((await post(AADI)).status).toBe(202)
    await app.load.runAll()
    expect((await statusBody()).feeds["lima-persen"].asOf).toBe(AS_OF)
  })

  test("retried late by its old attempt leaves the newer attempt loading", async () => {
    await fileIdOf(await post(AADI))
    let marks = 0
    let resent: Response | undefined

    await expect(
      app.load.runAll({
        repeatEachStep: true,
        beforeAttempt: async (step) => {
          failConfirm(step)
          if (step === "mark the file failed" && ++marks === 2)
            resent = await post(AADI)
        },
      })
    ).rejects.toThrow("D1 went away")

    expect(resent?.status).toBe(202)
    const status = await statusBody()
    expect(status.failed).toEqual([])
    expect(status.loading).toHaveLength(1)
    await app.load.runAll()
    expect((await statusBody()).feeds["lima-persen"].asOf).toBe(AS_OF)
  })

  test("of a newer version leaves the earlier version in force", async () => {
    await fileIdOf(await post(AADI))
    await app.load.runAll()

    vi.setSystemTime(new Date(T2))
    await fileIdOf(await post(RECONVERTED, REVISED_SOURCE))
    await expect(
      app.load.runAll({ beforeAttempt: failConfirm })
    ).rejects.toThrow("D1 went away")

    const status = await statusBody()
    expect(status.failed).toHaveLength(1)
    expect(status.feeds["lima-persen"].firstReceivedAt).toBe(T1)
  })
})

describe("the same source with a different CSV", () => {
  test("returns 409 with the existing CSV hash and stores nothing", async () => {
    await post(AADI)

    const conflict = await post(RECONVERTED)

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ csvSha256: sha256(AADI) })
    expect(await versionCount()).toBe(1)
    expect(app.files.keys()).toHaveLength(1)
  })

  test("returns 409 when the replace header names another hash", async () => {
    await post(AADI)

    const conflict = await post(RECONVERTED, SOURCE, {
      "X-Replaces-CSV-SHA256": sha256("not the current one"),
    })

    expect(conflict.status).toBe(409)
    expect(await versionCount()).toBe(1)
  })

  test("with a valid replace header adds a version, in force, keeping the earlier one", async () => {
    const first = await fileIdOf(await post(AADI))
    await app.load.runAll()

    vi.setSystemTime(new Date(T2))
    const second = await fileIdOf(
      await post(RECONVERTED, SOURCE, {
        "X-Replaces-CSV-SHA256": sha256(AADI),
      })
    )
    await app.load.runAll()

    expect(second).not.toBe(first)
    expect(await versionCount()).toBe(2)
    expect((await statusBody()).feeds["lima-persen"].firstReceivedAt).toBe(T2)
    expect(await rowsOf(first)).toBe(16)
    expect(await rowsOf(second)).toBe(16)
    expect(app.files.keys()).toHaveLength(2)
  })

  test("must then replace the latest version, not the first", async () => {
    await post(AADI)
    vi.setSystemTime(new Date(T2))
    await post(RECONVERTED, SOURCE, { "X-Replaces-CSV-SHA256": sha256(AADI) })
    vi.setSystemTime(new Date(T3))
    const third = AADI.replace("84301663", "84301665")

    const stale = await post(third, SOURCE, {
      "X-Replaces-CSV-SHA256": sha256(AADI),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ csvSha256: sha256(RECONVERTED) })

    const current = await post(third, SOURCE, {
      "X-Replaces-CSV-SHA256": sha256(RECONVERTED),
    })
    expect(current.status).toBe(202)
  })
})

// Either order, as a tie left to SQLite resolves by something other than arrival.
describe.each([
  ["one order", AADI, RECONVERTED],
  ["the other order", RECONVERTED, AADI],
])("versions received in the same millisecond, %s", (_, first, second) => {
  const replacing = (csv: string) => ({
    "X-Replaces-CSV-SHA256": sha256(csv),
  })
  const third = AADI.replace("84301663", "84301665")

  test("a replacement of the earlier is refused, naming the later", async () => {
    await post(first)
    await post(second, SOURCE, replacing(first))

    const stale = await post(third, SOURCE, replacing(first))

    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ csvSha256: sha256(second) })
  })

  test("concurrent replacements of the same version admit one", async () => {
    await post(first)
    app.files.holdPutsUntil(2)

    const responses = await Promise.all([
      post(second, SOURCE, replacing(first)),
      post(third, SOURCE, replacing(first)),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409,
    ])
  })
})

describe("a different source for the same dataset and as-of", () => {
  test("adds a revision in force, and the earlier version stays", async () => {
    const first = await fileIdOf(await post(AADI))
    await app.load.runAll()

    vi.setSystemTime(new Date(T2))
    const second = await fileIdOf(await post(RECONVERTED, REVISED_SOURCE))
    expect((await statusBody()).feeds["lima-persen"].firstReceivedAt).toBe(T1)

    await app.load.runAll()

    expect((await statusBody()).feeds["lima-persen"].firstReceivedAt).toBe(T2)
    expect(await rowsOf(first)).toBe(16)
    expect(await rowsOf(second)).toBe(16)
  })

  test("adds a version even when the CSV is byte for byte the same", async () => {
    await post(AADI)
    await fileIdOf(await post(AADI, REVISED_SOURCE))
    expect(await versionCount()).toBe(2)
  })

  test("re-sending an earlier version leaves the later one in force", async () => {
    await post(AADI)
    vi.setSystemTime(new Date(T2))
    await post(RECONVERTED, REVISED_SOURCE)
    await app.load.runAll()

    vi.setSystemTime(new Date(T3))
    expect((await post(AADI)).status).toBe(200)
    expect((await statusBody()).feeds["lima-persen"].firstReceivedAt).toBe(T2)
  })
})

describe("concurrent requests", () => {
  const statusesOf = (responses: ReadonlyArray<Response>) =>
    responses.map((response) => response.status).sort()

  test("replacing the same predecessor admit one, and the other gets 409 naming it", async () => {
    await fileIdOf(await post(AADI))
    vi.setSystemTime(new Date(T2))
    const replaces = { "X-Replaces-CSV-SHA256": sha256(AADI) }
    const other = AADI.replace("84301663", "84301665")

    app.files.holdPutsUntil(2)
    const responses = await Promise.all([
      post(RECONVERTED, SOURCE, replaces),
      post(other, SOURCE, replaces),
    ])

    expect(statusesOf(responses)).toEqual([202, 409])
    expect(await versionCount()).toBe(2)
    const [first, second] = responses
    const loser = first?.status === 409 ? first : second
    const winnerCsv = first?.status === 409 ? other : RECONVERTED
    expect(await loser?.json()).toEqual({ csvSha256: sha256(winnerCsv) })
  })

  test("carrying the same file admit one, and the other answers as a re-send", async () => {
    app.files.holdPutsUntil(2)
    const responses = await Promise.all([post(AADI), post(AADI)])

    expect(statusesOf(responses)).toEqual([200, 202])
    expect(await versionCount()).toBe(1)
    const bodies = (await Promise.all(
      responses.map((response) => response.json())
    )) as Array<{ fileId: string }>
    expect(bodies[0]?.fileId).toBe(bodies[1]?.fileId)
    expect(app.load.ids()).toEqual([`${bodies[0]?.fileId}-1`])
  })
})

describe("a structural fault", () => {
  const [HEADER = "", FIRST = ""] = AADI.split("\n")

  const REFUSED = { code: 400, versions: 0, files: [], instances: [] }

  const outcomeOf = async (response: Response) => ({
    code: response.status,
    versions: await versionCount(),
    files: app.files.keys(),
    instances: app.load.ids(),
  })

  test("an unknown dataset", async () => {
    expect(
      await outcomeOf(
        await app.postCsv(AADI, { asOf: AS_OF, dataset: "sepuluh-persen" })
      )
    ).toEqual(REFUSED)
  })

  test.each(["X-As-Of", "X-Row-Count", "X-Source-Filename", "X-Source-SHA256"])(
    "a missing %s",
    async (name) => {
      expect(
        await outcomeOf(
          await app.postCsv(AADI, { asOf: AS_OF, omitHeader: name })
        )
      ).toEqual(REFUSED)
    }
  )

  test.each([
    ["X-As-Of", "29-05-2026"],
    ["X-As-Of", "2026-02-31"],
    ["X-Row-Count", "16 rows"],
    ["X-Source-Filename", ""],
    ["X-Source-SHA256", "not-a-hash"],
    ["X-Replaces-CSV-SHA256", "not-a-hash"],
  ])("a malformed %s: %s", async (name, value) => {
    expect(
      await outcomeOf(
        await app.postCsv(AADI, { asOf: AS_OF, headers: { [name]: value } })
      )
    ).toEqual(REFUSED)
  })

  test("columns other than the dataset's", async () => {
    expect(
      await outcomeOf(await post(AADI.replace("holder_name", "nama_pemegang")))
    ).toEqual(REFUSED)
  })

  test("a row count differing from X-Row-Count", async () => {
    expect(
      await outcomeOf(await app.postCsv(AADI, { asOf: AS_OF, rowCount: 15 }))
    ).toEqual(REFUSED)
  })

  test("an as_of differing from X-As-Of", async () => {
    expect(
      await outcomeOf(await app.postCsv(AADI, { asOf: "2026-05-28" }))
    ).toEqual(REFUSED)
  })

  test("one row's as_of differing from X-As-Of", async () => {
    const lines = AADI.split("\n")
    lines[3] = lines[3]?.replace(AS_OF, "2026-05-28") ?? ""
    expect(await outcomeOf(await post(lines.join("\n")))).toEqual(REFUSED)
  })

  test("a number written with separators", async () => {
    expect(
      await outcomeOf(
        await post(`${HEADER}\n${FIRST.replace("84301663", '"84,301,663"')}\n`)
      )
    ).toEqual(REFUSED)
  })

  test("a real number too large to be finite", async () => {
    const huge = `${"9".repeat(400)}.5`
    expect(
      await outcomeOf(
        await post(`${HEADER}\n${FIRST.replace("41.10", huge)}\n`)
      )
    ).toEqual(REFUSED)
  })

  test("an empty numeric cell is accepted", async () => {
    const emptied = FIRST.replace(
      ",84301663,3200142830,41.10,0",
      ",,3200142830,41.10,0"
    )
    expect(emptied).not.toBe(FIRST)
    const fileId = await fileIdOf(await post(`${HEADER}\n${emptied}\n`))
    await app.load.runAll()
    expect(await rowsOf(fileId)).toBe(1)
  })
})

describe("above the size limit", () => {
  const LIMIT = 32 * 1024 * 1024

  test("a body past 32 MB returns 413 and stores nothing", async () => {
    const response = await post("x".repeat(LIMIT + 1))
    expect(response.status).toBe(413)
    expect(await versionCount()).toBe(0)
    expect(app.files.keys()).toEqual([])
  })

  test("a body with no declared length stops being read past 32 MB", async () => {
    const MiB = 1024 * 1024
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 64 * MiB) return controller.close()
        pulled += MiB
        controller.enqueue(new Uint8Array(MiB))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await worker.fetch(
      new Request(
        "https://kumora.test/api/ownership/imports?dataset=lima-persen",
        {
          method: "POST",
          body,
          duplex: "half",
          headers: {
            Authorization: `Bearer ${OWNERSHIP_SECRET}`,
            "X-As-Of": "2026-05-29",
            "X-Row-Count": "1",
            "X-Source-Filename": "peng.xlsx",
            "X-Source-SHA256": SOURCE,
          },
        } as RequestInit
      ),
      app.env
    )
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(40 * MiB)
    expect(await versionCount()).toBe(0)
  })

  test("a declared length past 32 MB returns 413 without reading the body", async () => {
    const response = await post(AADI, SOURCE, {
      "Content-Length": String(LIMIT + 1),
    })
    expect(response.status).toBe(413)
    expect(await versionCount()).toBe(0)
  })
})
