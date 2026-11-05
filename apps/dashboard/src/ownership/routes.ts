import { parseAsOf } from "./as-of"
import { checkImport, csvKey, isDataset } from "./csv"
import { errorMessage } from "./error-message"
import { parseRunReport } from "./run-report"
import { statusResponse } from "./status"
import {
  insertFile,
  insertRunReport,
  markFailed,
  readStatusRows,
  readVersions,
  restartFile,
} from "./store"
import type { FileStatus, FileVersion } from "./store"

/** The operator's `_scripts/kirim.py`, outside this repo, posts here. Change the two together. */
export const IMPORTS_PATH = "/api/ownership/imports"
/** The operator's `_scripts/lapor.py`, outside this repo, posts here. Change the two together. */
export const RUNS_PATH = "/api/ownership/runs"
/** The operator's `_scripts/kirim.py`, outside this repo, polls this. Change the two together. */
export const OWNERSHIP_STATUS_PATH = "/api/ownership/status"

const MAX_CSV_BYTES = 32 * 1024 * 1024

const badRequest = (reason: string) => new Response(reason, { status: 400 })
const tooLarge = () => new Response("above 32 MB", { status: 413 })

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")

const SHA256 = /^[0-9a-f]{64}$/

/**
 * Each required header's rule. The operator's `_scripts/kirim.py`, outside this repo, sends them,
 * and `X-As-Of`, parsed in `readImportHeaders`. `kirim.py --ganti` sends `X-Replaces-CSV-SHA256`,
 * the optional header parsed there too. Change the two together.
 */
const REQUIRED_HEADERS = {
  "X-Row-Count": (value: string) => /^\d+$/.test(value),
  "X-Source-Filename": (value: string) => value !== "",
  "X-Source-SHA256": (value: string) => SHA256.test(value),
}

/** The request's description of its file, or null when a header is missing or malformed. */
const readImportHeaders = (headers: Headers) => {
  const valid = Object.entries(REQUIRED_HEADERS).every(([name, isValid]) =>
    isValid(headers.get(name) ?? "")
  )
  const replaces = headers.get("X-Replaces-CSV-SHA256")
  const asOf = parseAsOf(headers.get("X-As-Of") ?? "")
  if (!valid || asOf === null) return null
  if (replaces !== null && !SHA256.test(replaces)) return null
  return {
    asOf,
    rowCount: Number(headers.get("X-Row-Count")),
    sourceFilename: headers.get("X-Source-Filename") ?? "",
    sourceSha256: headers.get("X-Source-SHA256") ?? "",
    replaces,
  }
}

/** The operator's `_scripts/kirim.py`, outside this repo, reads these keys. Change the two together. */
const fileResponse = (fileId: string, status: FileStatus, code: number) =>
  Response.json({ fileId, status }, { status: code })

/**
 * Creates the file's Workflow instance unless it already exists. `create` throws for an id in use
 * but documents no message for it, so `get`, which throws for a missing id, tells the two apart.
 */
const ensureInstance = async (env: Env, fileId: string, attempt: number) => {
  const id = `${fileId}-${attempt}`
  try {
    return await env.OWNERSHIP_LOAD.create({ id, params: { fileId, attempt } })
  } catch (error) {
    return env.OWNERSHIP_LOAD.get(id).catch(() => {
      throw error
    })
  }
}

const couldNotStart = () =>
  new Response("the load could not start", { status: 503 })

/** A file's first or next attempt. One that cannot start is failed, so a re-send recovers it. */
const startLoad = async (env: Env, fileId: string, attempt: number) => {
  try {
    await ensureInstance(env, fileId, attempt)
  } catch (error) {
    await markFailed(env.OWNERSHIP_DB, fileId, attempt, errorMessage(error))
    return couldNotStart()
  }
  return fileResponse(fileId, "loading", 202)
}

/**
 * The next attempt of a failed file. Another request that got there first answers as a re-send of a
 * loading file.
 */
const restartLoad = async (env: Env, fileId: string) => {
  const attempt = await restartFile(env.OWNERSHIP_DB, fileId)
  return attempt === null
    ? fileResponse(fileId, "loading", 200)
    : startLoad(env, fileId, attempt)
}

/**
 * A request can die between inserting a file and creating its instance, so a re-send makes sure of
 * the instance. It stays loading if that fails, as an instance may yet be running. An instance can
 * also stop without marking its file failed, and then the attempt fails here.
 */
const recoverLoad = async (env: Env, { id, attempt }: FileVersion) => {
  let status: InstanceStatus["status"]
  try {
    const instance = await ensureInstance(env, id, attempt)
    ;({ status } = await instance.status())
  } catch {
    return couldNotStart()
  }
  if (status !== "errored" && status !== "terminated")
    return fileResponse(id, "loading", 200)
  await markFailed(env.OWNERSHIP_DB, id, attempt, `the instance ${status}`)
  return restartLoad(env, id)
}

/** The response table's rows for a file already held. */
const resend = async (env: Env, found: FileVersion) => {
  if (found.status === "loaded") return fileResponse(found.id, "loaded", 200)
  return found.status === "loading"
    ? recoverLoad(env, found)
    : restartLoad(env, found.id)
}

/** `_scripts/kirim.py` records this key on a 409. Change the two together. */
const conflict = (current: string | undefined) =>
  Response.json({ csvSha256: current }, { status: 409 })

/** A request whose insert lost a race answers by what won: its own file, or a later version. */
const answerLostInsert = async (
  env: Env,
  sourceSha256: string,
  csvSha256: string
) => {
  const versions = await readVersions(env.OWNERSHIP_DB, sourceSha256)
  const found = versions.find((version) => version.csv_sha256 === csvSha256)
  return found === undefined
    ? conflict(versions[0]?.csv_sha256)
    : resend(env, found)
}

/** The body's bytes, or null once past the limit. A declared length can be absent, so count as it arrives. */
const readBody = async (request: Request) => {
  const chunks: Array<Uint8Array> = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_CSV_BYTES) return null
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** `POST /api/ownership/imports?dataset=<dataset>`. */
export const postImport = async (request: Request, env: Env) => {
  if (Number(request.headers.get("Content-Length")) > MAX_CSV_BYTES)
    return tooLarge()

  const dataset = new URL(request.url).searchParams.get("dataset")
  if (!isDataset(dataset)) return badRequest("unknown dataset")

  const headers = readImportHeaders(request.headers)
  if (headers === null) return badRequest("missing or malformed header")

  const bytes = await readBody(request)
  if (bytes === null) return tooLarge()
  const check = checkImport(dataset, new TextDecoder().decode(bytes), headers)
  if (!check.ok) return badRequest(check.reason)

  const csvSha256 = hex(await crypto.subtle.digest("SHA-256", bytes))
  const versions = await readVersions(env.OWNERSHIP_DB, headers.sourceSha256)
  const found = versions.find((version) => version.csv_sha256 === csvSha256)
  if (found !== undefined) {
    // A failed file may have lost its CSV, and this request carries the same bytes.
    if (found.status === "failed")
      await env.OWNERSHIP_FILES.put(csvKey(dataset, csvSha256), bytes)
    return resend(env, found)
  }

  const current = versions[0]?.csv_sha256
  if (current !== undefined && headers.replaces !== current)
    return conflict(current)

  const fileId = crypto.randomUUID()
  await env.OWNERSHIP_FILES.put(csvKey(dataset, csvSha256), bytes)
  const inserted = await insertFile(
    env.OWNERSHIP_DB,
    {
      id: fileId,
      dataset,
      as_of: headers.asOf,
      source_filename: headers.sourceFilename,
      source_sha256: headers.sourceSha256,
      csv_sha256: csvSha256,
      row_count: headers.rowCount,
      first_received_at: new Date().toISOString(),
    },
    headers.replaces
  )
  return inserted
    ? startLoad(env, fileId, 1)
    : answerLostInsert(env, headers.sourceSha256, csvSha256)
}

/** `GET /api/ownership/status`. */
export const getStatus = async (env: Env) =>
  Response.json(
    statusResponse(await readStatusRows(env.OWNERSHIP_DB), Date.now())
  )

/** `POST /api/ownership/runs`. */
export const postRun = async (request: Request, env: Env) => {
  const report = parseRunReport(await request.text())
  if (report === null) return badRequest("malformed run report")
  await insertRunReport(env.OWNERSHIP_DB, report, new Date().toISOString())
  return new Response(null, { status: 204 })
}
