// Seeds one of the Test stage's archive buckets. `alchemy dev` serves every
// local R2 bucket on the dashboard Worker's S3-compatible endpoint
// (repos/alchemy, packages/cloudflare/src/R2/LocalS3.ts), with a fixed,
// well-known key pair that only guards localhost, so a spec writes reports
// there, signed with SigV4, as an S3 client would.
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
const bucketName = (resource: string) => {
  const state = new URL(
    `../../dashboard/.alchemy/state/${Effect.runSync(stackName("dashboard"))}/${TEST}/${resource}.json`,
    import.meta.url
  )
  const { attr } = JSON.parse(readFileSync(state, "utf8")) as {
    attr: { bucketName: string }
  }
  return attr.bucketName
}

const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest()

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex")

/**
 * One SigV4-signed PUT of an object, with its custom metadata, into the
 * bucket of the resource `resource` in apps/dashboard/alchemy.run.ts.
 */
export async function putObject(
  resource: string,
  key: string,
  body: string | Uint8Array<ArrayBuffer>,
  contentType: string,
  metadata: Readonly<Record<string, string>> = {}
) {
  const url = new URL(
    `${S3_PATH}/${encodeURIComponent(bucketName(resource))}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    DASHBOARD
  )
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")
  const day = amzDate.slice(0, 8)
  const payloadHash = sha256(body)
  // Sent and signed, in name order as SigV4 signs them; fetch sets host.
  const sent = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...Object.fromEntries(
      Object.entries(metadata)
        .map(([name, value]) => [`x-amz-meta-${name}`, value] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1))
    ),
  }
  const headers = { host: url.host, ...sent }
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
      ...sent,
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
