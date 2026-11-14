// Seeds the Test stage's shareholding archive bucket. `alchemy dev` serves
// every local R2 bucket on the dashboard Worker's S3-compatible endpoint
// (repos/alchemy, packages/cloudflare/src/R2/LocalS3.ts), with a fixed,
// well-known key pair that only guards localhost, so a spec writes runs/
// records there, signed with SigV4, as an S3 client would.
import { TEST, stackName } from "@workspace/deploy"
import * as Effect from "effect/Effect"
import { createHash, createHmac } from "node:crypto"
import { readFileSync } from "node:fs"

import { DASHBOARD } from "./accounts"

const S3_PATH = "/cdn-cgi/local/r2/s3"
const ACCESS_KEY = "alchemy-local-r2"
const SECRET_KEY = "alchemy-local-r2-secret"
const REGION = "auto"

// The local bucket's name, `dev:<uuid>`, from the Test stage's Alchemy state:
// reset-test-stage.ts deletes that state, so each run gets an empty bucket.
// The file is named by the bucket resource's id in
// apps/dashboard/alchemy.run.ts.
const bucketName = () => {
  const state = new URL(
    `../../dashboard/.alchemy/state/${Effect.runSync(stackName("dashboard"))}/${TEST}/ShareholdingArchiveBucket.json`,
    import.meta.url
  )
  const { attr } = JSON.parse(readFileSync(state, "utf8")) as {
    attr: { bucketName: string }
  }
  return attr.bucketName
}

const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest()

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex")

// One SigV4-signed PUT of an object.
async function put(key: string, body: string, contentType: string) {
  const url = new URL(
    `${S3_PATH}/${encodeURIComponent(bucketName())}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    DASHBOARD
  )
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")
  const day = amzDate.slice(0, 8)
  const payloadHash = sha256(body)
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  }
  const signedHeaders = Object.keys(headers).join(";")
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    ...Object.entries(headers).map(([name, v]) => `${name}:${v}`),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n")
  const scope = `${day}/${REGION}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n")
  const signingKey = ["s3", "aws4_request"].reduce<Buffer>(
    (signing, part) => hmac(signing, part),
    hmac(hmac(`AWS4${SECRET_KEY}`, day), REGION)
  )
  const signature = hmac(signingKey, stringToSign).toString("hex")
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "content-type": contentType,
      authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  })
  if (!response.ok)
    throw new Error(
      `Seeding ${key} answered ${response.status}: ${await response.text()}`
    )
}

const putJson = (key: string, value: unknown) =>
  put(key, JSON.stringify(value), "application/json")

/** An archive run's result, as runs/<id>.json holds it. */
export interface SeededRun {
  readonly id: string
  readonly trigger: "cron" | "admin"
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly outcome: "running" | "complete" | "partial" | "failed"
  readonly reportsAdded: number
  readonly newVersions: number
  readonly reportsChecked: number
  readonly notStored: ReadonlyArray<string>
  readonly other: ReadonlyArray<{
    readonly sourceUrl: string
    readonly description: string
  }>
  readonly error: string | null
}

/**
 * Writes the run's record and leaves runs/latest.json alone, so it can run
 * beside the specs that point it at their own run.
 */
export async function seedRun(run: SeededRun) {
  await putJson(`runs/${run.id}.json`, run)
}

/** Writes the run's record and points runs/latest.json at it. */
export async function seedLatestRun(run: SeededRun) {
  await seedRun(run)
  await putJson("runs/latest.json", { id: run.id })
}

/**
 * Stores a report under `reports/<kind>/<data date>/` as an archive run
 * would: `bytes` bytes of file, then its listing record.
 */
export async function seedReport(prefix: string, hash: string, bytes: number) {
  await put(
    `reports/${prefix}/${hash}.xlsx`,
    "x".repeat(bytes),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
  await putJson(`reports/${prefix}/${hash}.20261114T060000000Z.0000.json`, {
    sha256: hash,
  })
}
