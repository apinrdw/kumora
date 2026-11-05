import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"

import { csvKey, readChunk } from "./csv"
import type { Dataset } from "./csv"
import { errorMessage } from "./error-message"
import { flagRows } from "./flags"
import {
  confirmLoaded,
  markFailed,
  readFile,
  readRowsOfSymbols,
  readSymbols,
  upsertFlags,
  upsertRows,
} from "./store"

export type LoadEvent = { readonly fileId: string; readonly attempt: number }

const CHUNK_ROWS = 1000

/**
 * At about 740 rows a symbol, all of them flagged, a step reads about 7,400 rows and writes about
 * 300 statements of 25 flags, against D1's 1,000 queries per invocation. About 100 steps a file.
 */
const FLAG_SYMBOLS = 10

/** The CSV kept in R2. Stored files passed the import's checks on arrival. */
const readCsv = async (env: Env, dataset: Dataset, csvSha256: string) => {
  const object = await env.OWNERSHIP_FILES.get(csvKey(dataset, csvSha256))
  if (object === null) throw new Error(`no CSV kept for ${csvSha256}`)
  return object.text()
}

/** Loads one Ownership file: a step per chunk, a step per batch of symbols flagging their rows, one confirming the count. */
export class OwnershipLoad extends WorkflowEntrypoint<Env, LoadEvent> {
  override async run(
    event: Readonly<WorkflowEvent<LoadEvent>>,
    step: WorkflowStep
  ) {
    const { fileId, attempt } = event.payload
    try {
      await this.load(fileId, attempt, step)
    } catch (error) {
      // Steps exhausted their retries. Rethrown so the instance shows as errored too.
      await step.do("mark the file failed", async () => {
        await markFailed(
          this.env.OWNERSHIP_DB,
          fileId,
          attempt,
          errorMessage(error)
        )
      })
      throw error
    }
  }

  private async load(fileId: string, attempt: number, step: WorkflowStep) {
    const db = this.env.OWNERSHIP_DB
    const file = await step.do("read the file", async () => {
      const found = await readFile(db, fileId)
      if (found === null) throw new Error(`no file ${fileId}`)
      return found
    })
    const { dataset, csv_sha256: csvSha256, row_count: rowCount } = file

    for (let start = 0; start < rowCount; start += CHUNK_ROWS) {
      const end = Math.min(start + CHUNK_ROWS, rowCount)
      await step.do(`rows ${start + 1} to ${end}`, async () => {
        const csv = await readCsv(this.env, dataset, csvSha256)
        const rows = readChunk(dataset, csv, start, end)
        await upsertRows(db, dataset, fileId, start + 1, rows)
      })
    }

    const symbols = await step.do("read the symbols", () =>
      readSymbols(db, dataset, fileId)
    )
    for (let start = 0; start < symbols.length; start += FLAG_SYMBOLS) {
      const batch = symbols.slice(start, start + FLAG_SYMBOLS)
      await step.do(
        `flag symbols ${start + 1} to ${start + batch.length}`,
        async () => {
          const rows = await readRowsOfSymbols(db, dataset, fileId, batch)
          await upsertFlags(db, fileId, flagRows(dataset, rows))
        }
      )
    }

    await step.do("confirm the row count", async () => {
      await confirmLoaded(db, dataset, file, attempt)
    })
  }
}
