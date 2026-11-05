import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

import { beforeEach, describe, expect, test, vi } from "vitest"

import type { AsOf } from "@/ownership/as-of"
import type * as HolderKey from "@/ownership/holder-key"
import { checkImport } from "@/ownership/csv"

import { fixture, ownershipWorker } from "../support/ownership"

const onHolderKey = vi.hoisted(() => ({ call: () => {} }))

vi.mock("@/ownership/holder-key", async (original) => {
  const actual = await original<typeof HolderKey>()
  return {
    holderKey: (name: string) => {
      onHolderKey.call()
      return actual.holderKey(name)
    },
  }
})

const AS_OF = "2026-05-29" as AsOf
const [HEADER = "", ...DATA] = fixture(`lima-persen-${AS_OF}.csv`)
  .trimEnd()
  .split("\n")

const csvOf = (rowCount: number) => {
  const lines = Array.from(
    { length: rowCount },
    (_, i) => DATA[i % DATA.length]
  )
  return `${[HEADER, ...lines].join("\n")}\n`
}

const MiB = 1024 * 1024

const retainedHeap = () => {
  setFlagsFromString("--expose-gc")
  const gc = runInNewContext("gc") as () => void
  gc()
  return process.memoryUsage().heapUsed
}

describe("a large file's memory", () => {
  beforeEach(() => {
    onHolderKey.call = () => {}
  })

  test("validating holds no earlier row when it reaches the last", () => {
    const rowCount = 30_000
    const csv = csvOf(rowCount)
    const before = retainedHeap()
    let seen = 0
    let atLastRow = before
    onHolderKey.call = () => {
      seen++
      if (seen === rowCount) atLastRow = retainedHeap()
    }

    const check = checkImport("lima-persen", csv, {
      asOf: AS_OF,
      rowCount,
    })

    expect(check.ok).toBe(true)
    expect(seen).toBe(rowCount)
    expect((atLastRow - before) / MiB).toBeLessThan(5)
  })

  test("a chunk's step reads no further than its chunk", async () => {
    const app = ownershipWorker()
    const csv = csvOf(1500)
    const response = await app.postCsv(csv, { asOf: AS_OF })
    expect(response.status).toBe(202)

    const lines = csv.split("\n")
    lines[1200] = 'unclosed "quote'
    const [key = ""] = app.files.keys()
    await app.files.put(key, lines.join("\n"))

    await expect(app.load.runAll()).rejects.toThrow("malformed")
    const stored = await app.db
      .prepare("SELECT COUNT(*) AS n FROM holding_lines_5")
      .first<{ n: number }>()
    expect(stored?.n).toBe(1000)
  })
})
