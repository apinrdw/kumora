import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"

import { OwnershipLoad } from "@/ownership/load-workflow"
import {
  IMPORTS_PATH,
  OWNERSHIP_STATUS_PATH,
  RUNS_PATH,
} from "@/ownership/routes"
import worker from "@/server"

import { d1Database } from "./d1"
import { r2Bucket } from "./r2"
import { workflowBinding } from "./workflow"

export const OWNERSHIP_SECRET = "ownership-secret"
export const RELAY_SECRET = "relay-secret"
const ORIGIN = "https://dash.example"

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex")

export const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/ownership/${name}`, import.meta.url),
    "utf8"
  )

/** A Worker with in-memory bindings, driven only through its fetch handler. */
export const ownershipWorker = (onRead?: (rowCount: number) => void) => {
  const db = d1Database(onRead)
  const files = r2Bucket()
  const env = {
    RELAY_INGEST_SECRET: RELAY_SECRET,
    OWNERSHIP_INGEST_SECRET: OWNERSHIP_SECRET,
    OWNERSHIP_DB: db,
    OWNERSHIP_FILES: files,
  } as unknown as Env
  const load = workflowBinding(
    () => new OwnershipLoad({} as ExecutionContext, env) as never
  )
  env.OWNERSHIP_LOAD = load.binding as Env["OWNERSHIP_LOAD"]

  const postCsv = (
    csv: string,
    {
      asOf,
      dataset = "lima-persen",
      rowCount = csv.trimEnd().split("\n").length - 1,
      secret = OWNERSHIP_SECRET,
      sourceSha256 = sha256(`xlsx of ${csv}`),
      headers = {},
      omitHeader,
    }: {
      asOf: string
      dataset?: string
      rowCount?: number
      secret?: string
      sourceSha256?: string
      /** Added to, or overriding, the headers a good request carries. */
      headers?: Readonly<Record<string, string>>
      omitHeader?: string
    }
  ) => {
    const sent = new Headers({
      Authorization: `Bearer ${secret}`,
      "Content-Type": "text/csv",
      "X-As-Of": asOf,
      "X-Row-Count": String(rowCount),
      "X-Source-Filename": `peng-${asOf}-${dataset}.xlsx`,
      "X-Source-SHA256": sourceSha256,
      ...headers,
    })
    if (omitHeader !== undefined) sent.delete(omitHeader)
    return worker.fetch(
      new Request(`${ORIGIN}${IMPORTS_PATH}?dataset=${dataset}`, {
        method: "POST",
        body: csv,
        headers: sent,
      }),
      env
    )
  }

  const status = (secret = OWNERSHIP_SECRET) =>
    worker.fetch(
      new Request(`${ORIGIN}${OWNERSHIP_STATUS_PATH}`, {
        headers: { Authorization: `Bearer ${secret}` },
      }),
      env
    )

  /** A string is sent as it is, so a test can post a body that is not JSON. */
  const postRun = (report: unknown, secret = OWNERSHIP_SECRET) =>
    worker.fetch(
      new Request(`${ORIGIN}${RUNS_PATH}`, {
        method: "POST",
        body: typeof report === "string" ? report : JSON.stringify(report),
        headers: { Authorization: `Bearer ${secret}` },
      }),
      env
    )

  return { db, files, load, env, postCsv, postRun, status }
}
